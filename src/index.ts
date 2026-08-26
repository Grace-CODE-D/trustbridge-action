import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  detectNetworkMismatch,
  horizonFailureResult,
  parseMinXlmReserve,
  runAccountChecks,
  unfundedAccountResult,
  validateStellarAddress,
  HomeDomainCheckMode,
  LedgerFreshnessCheckResult,
} from './checks';
import { fetchAccount, HorizonError, waitForFundedAccount } from './horizon';
import { checkLedgerFreshness } from './freshness';
import { formatCommentBody, postIssueComment, postDiscussionComment, resolveDiscussionNodeId, COMMENT_SIZE_LIMIT_BYTES, buildTruncatedCommentBody, writeFullReport } from './comment';
import { normalizeAssetConfig, parseAssetsJson } from './assets';
import {
  getErrorMessage,
  parseAssigneeAddressMap,
  parseBooleanInput,
  parseNumberInput,
  resolveAddressFromAssigneeMap,
} from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs, writeValidationJson } from './outputs';
import {
  computeValidationDelta,
  loadPreviousValidationArtifact,
} from './delta';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics, writeJobSummary } from './metrics';
import { RateBudgetTracker } from './resilience';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { parseLocaleInput } from './i18n';
import { sendWebhookNotification } from './webhook';
import { runIssuesPreflight } from './preflight';

/**
 * Resolve the GitHub assignee login from the current Actions event payload.
 * Prefers `payload.assignee` (issues.assigned), then the first issue assignee.
 */
function resolveAssigneeLoginFromContext(): string | undefined {
  const payload = github.context.payload as {
    assignee?: { login?: string };
    issue?: { assignees?: Array<{ login?: string }> };
  };

  const fromEvent = payload.assignee?.login?.trim();
  if (fromEvent) {
    return fromEvent;
  }

  const assignees = payload.issue?.assignees;
  if (Array.isArray(assignees)) {
    for (const entry of assignees) {
      const login = entry?.login?.trim();
      if (login) {
        return login;
      }
    }
  }

  return undefined;
}

/**
 * Resolve the Stellar G-address to validate: either from assignee_address_map
 * (GitHub username → address roster) or from stellar_address_input.
 */
function resolveStellarAddressInput(
  stellarAddressInput: string,
  assigneeAddressMapRaw: string,
): string {
  const mapRaw = assigneeAddressMapRaw.trim();
  if (mapRaw) {
    const map = parseAssigneeAddressMap(mapRaw, {
      workspaceRoot: process.env.GITHUB_WORKSPACE || process.cwd(),
    });
    const assigneeLogin = resolveAssigneeLoginFromContext();
    return resolveAddressFromAssigneeMap(map, assigneeLogin);
  }

  const direct = stellarAddressInput.trim();
  if (direct) {
    return direct;
  }

  throw new Error(
    'Provide stellar_address_input (a Stellar G-address) or assignee_address_map ' +
      '(JSON / file path mapping GitHub usernames to G-addresses).',
  );
}

async function run(): Promise<void> {
  const horizonUrl = core.getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || 'USDC';
  const assetIssuer =
    core.getInput('asset_issuer') ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw = core.getInput('min_xlm_reserve') || '1.5';
  const stellarAddressInput = core.getInput('stellar_address_input');
  const assigneeAddressMapRaw = core.getInput('assignee_address_map');
  const stellarAddress = resolveStellarAddressInput(stellarAddressInput, assigneeAddressMapRaw);
  const failOnMissing = parseBooleanInput(core.getInput('fail_on_missing'), true);
  const debugMode = parseBooleanInput(core.getInput('debug_mode'), false);
  const horizonTimeoutMs = parseNumberInput(core.getInput('horizon_timeout_ms'), 15000, {
    min: 1000,
    max: 60000,
  });
  const stickyComment = parseBooleanInput(core.getInput('sticky_comment'), true);
  const waitUntilFunded = parseBooleanInput(core.getInput('wait_until_funded'), false);
  const waitUntilFundedTimeoutMs = parseNumberInput(
    core.getInput('wait_until_funded_timeout_ms'),
    120000,
    { min: 0, max: 600000 },
  );
  const waitUntilFundedIntervalMs = parseNumberInput(
    core.getInput('wait_until_funded_interval_ms'),
    5000,
    { min: 1000, max: 60000 },
  );
  const horizonUrlFallback = core.getInput('horizon_url_fallback') || '';
  const rpcFallbackUrlRaw = core.getInput('rpc_fallback_url') || '';
  const fallbackUrls = rpcFallbackUrlRaw
    ? rpcFallbackUrlRaw.split(',').map((u) => u.trim()).filter(Boolean)
    : horizonUrlFallback
      ? [horizonUrlFallback]
      : [];
  const horizonCacheTtlMs = parseNumberInput(core.getInput('horizon_cache_ttl_ms'), 60000, {
    min: 0,
    max: 3_600_000,
  });
  const useCache = parseBooleanInput(core.getInput('use_cache'), false);
  const allowCrossNetworkFallback = parseBooleanInput(
    core.getInput('allow_cross_network_fallback'),
    false,
  );
  const logInputs = parseBooleanInput(core.getInput('log_inputs'), false);
  const trustbridgeConfigPath = core.getInput('trustbridge_config_path') || '.trustbridge.yml';
  const githubToken = core.getInput('github_token', { required: true });
  const autoWalletLabels = parseBooleanInput(core.getInput('auto_wallet_labels'), false);

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(core.getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = core.getInput('sep0007_origin_domain') || '';

  // #145 — issues:write preflight
  const preflightOnly = parseBooleanInput(core.getInput('preflight_only'), false);

  // Multi-asset trustline validation (Issue #4)
  const assetsJsonRaw = core.getInput('assets_json') || '';

  // Soroban contract registry (Issue #7)
  const sorobanRpcUrl = core.getInput('soroban_rpc_url') || '';
  const contractId = core.getInput('contract_id') || '';
  const githubUsername = core.getInput('github_username') || '';

  // Onboarding checklist in comments (Issue #154) — default on
  const onboardingChecklist = parseBooleanInput(core.getInput('onboarding_checklist'), true);

  // Security artifacts / delta vs previous run (Issue #148)
  const writeValidationJsonEnabled = parseBooleanInput(
    core.getInput('write_validation_json'),
    false,
  );
  const validationJsonPath = core.getInput('validation_json_path') || 'validation.json';
  const previousValidationPath = core.getInput('previous_validation_path') || '';
  const privacyMode = parseBooleanInput(core.getInput('privacy_mode'), false);

  // Internationalization (Issue #59)
  const localeInput = core.getInput('locale') || 'en';
  const locale = parseLocaleInput(localeInput);

  // Full-report artifact path (used when comment exceeds size limit)
  const reportOutputPath = core.getInput('report_output_path') || 'trustbridge-report.md';

  // Failure snooze window (Issue #155)
  const snoozeWindowMinutes = parseNumberInput(core.getInput('snooze_window_minutes'), 30, {
    min: 0,
    max: 10080, // 7 days
  });
  const forceComment = parseBooleanInput(core.getInput('force_comment'), false);
  const snoozeWindowMs = snoozeWindowMinutes * 60 * 1000;

  // Wave #30 — comment posting mode: post | dry-run | off
  const VALID_COMMENT_MODES = new Set(['post', 'dry-run', 'off']);
  const commentModeRaw = (core.getInput('comment_mode') || 'post').trim().toLowerCase();
  if (!VALID_COMMENT_MODES.has(commentModeRaw)) {
    throw new Error(
      `Invalid comment_mode "${commentModeRaw}". Expected one of: post, dry-run, off.`,
    );
  }
  const commentMode = commentModeRaw as 'post' | 'dry-run' | 'off';
  const shouldPostComment = commentMode === 'post';

  // Signed dashboard webhook (Issue #101)
  // dashboard_webhook_url is a Wave #38 / dry-run harness alias for webhook_url.
  const webhookUrl =
    core.getInput('webhook_url') || core.getInput('dashboard_webhook_url') || '';
  const webhookSecret = core.getInput('webhook_secret') || '';
  const webhookTimeoutMs = parseNumberInput(core.getInput('webhook_timeout_ms'), 5000, {
    min: 100,
    max: 30000,
  });

  // Clear validation spans from any prior run in the same process (safety).
  clearSpans();

  // Never weaken TLS verification by default (Issue #71). TrustBridge does
  // not set NODE_TLS_REJECT_UNAUTHORIZED itself; if something else in the
  // environment has disabled it, surface that loudly rather than silently
  // trusting an unverified Horizon endpoint.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    logger.warn(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is set in this environment — TLS certificate verification is disabled process-wide. TrustBridge does not set this itself; see docs/USAGE.md for private-mirror TLS guidance.',
      { component: 'index' },
    );
  }


  // Effective values (config-file overrides can wire in later; default to action inputs)
  const effectiveHorizonUrl = horizonUrl;
  const effectiveHorizonUrlFallback = horizonUrlFallback;
  const effectiveAssetCode = assetCode;
  const effectiveAssetIssuer = assetIssuer;
  const effectiveMinXlmReserveRaw = minXlmReserveRaw;
  const effectiveRpcFallbackUrl = rpcFallbackUrlRaw;
  const effectiveFailOnMissing = failOnMissing;
  const resolvedAddress = stellarAddress;
  const jobController = new AbortController();
  const horizonMaxRequests = parseNumberInput(
    core.getInput('horizon_max_requests') || '0',
    0,
    {
      min: 0, // 0 = unlimited (matches action.yml)
      max: 10000,
    },
  );
  const retryMaxDelayMs = parseNumberInput(core.getInput('retry_max_delay_ms') || '30000', 30000, {
    min: 0,
    max: 600_000,
  });

  logger.setDebugMode(debugMode);
  logger.debug('Action inputs loaded', {
    component: 'index',
    horizonUrl: effectiveHorizonUrl,
    horizonUrlFallback: effectiveHorizonUrlFallback,
    horizonCacheTtlMs,
    assetCode: effectiveAssetCode,
    assetIssuer: effectiveAssetIssuer,
    minXlmReserveRaw: effectiveMinXlmReserveRaw,
    debugMode,
    horizonTimeoutMs,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    rpcFallbackUrl: effectiveRpcFallbackUrl,
    useCache,
    allowCrossNetworkFallback,
    sep0007DeepLinks,
    onboardingChecklist,
    trustbridgeConfigPath,
  });

  validateStellarAddress(stellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);
  const minTrustlineLimitRaw = core.getInput('min_trustline_limit') || '';
  const minTrustlineLimit = minTrustlineLimitRaw ? parseNumberInput(minTrustlineLimitRaw, 0, { min: 0 }) : undefined;

  // Optional multi-asset JSON — validate early so bad input fails fast.
  if (assetsJsonRaw.trim()) {
    parseAssetsJson(assetsJsonRaw);
  }

  // #145 — issues:write preflight (optional early exit)
  // Skip when comment_mode won't post — dry-run/off don't need issues:write.
  // Skip for discussion events too: discussions use the GraphQL path which
  // requires `discussions: write`, not `issues: write` (Issue #221).
  const discussionNodeId = resolveDiscussionNodeId(github.context.payload);
  if (shouldPostComment && !discussionNodeId) {
    const preflight = await runIssuesPreflight(githubToken);
    if (preflight.skip) {
      core.info(preflight.message);
    }
  }
  if (preflightOnly) {
    core.info('preflight_only=true — exiting after issues:write preflight.');
    return;
  }

  // SEP-0001 home domain check inputs (optional, off by default)
  const homeDomainCheckEnabled = parseBooleanInput(core.getInput('home_domain_check_enabled'), false);
  const expectedHomeDomain = core.getInput('expected_home_domain').trim() || undefined;
  const homeDomainCheckModeRaw = core.getInput('home_domain_check_mode').trim().toLowerCase();
  const homeDomainCheckMode: HomeDomainCheckMode =
    homeDomainCheckModeRaw === 'strict' ? 'strict' : 'warn';

  // Ledger freshness / lag guard inputs (Issue #107 — optional, off by default)
  const checkLedgerFreshnessEnabled = parseBooleanInput(core.getInput('check_ledger_freshness'), false);
  const maxLedgerLagSeconds = parseNumberInput(core.getInput('max_ledger_lag_seconds') || '60', 60, { min: 1, max: 3600 });
  const ledgerFreshnessFailOnStale = parseBooleanInput(core.getInput('ledger_freshness_fail_on_stale'), false);

  if (logInputs) {
    emitInputsLogRecord({
      horizonUrl,
      horizonUrlFallback,
      rpcFallbackUrl: rpcFallbackUrlRaw,
      assetCode,
      assetIssuer,
      minXlmReserve: minXlmReserveRaw,
      minTrustlineLimit: minTrustlineLimitRaw,
      stellarAddress,
      failOnMissing: effectiveFailOnMissing,
      debugMode,
      horizonTimeoutMs,
      stickyComment,
      waitUntilFunded,
      waitUntilFundedTimeoutMs,
      waitUntilFundedIntervalMs,
      horizonCacheTtlMs,
      useCache,
      horizonMaxRequests,
      retryMaxDelayMs,
      allowCrossNetworkFallback,
      logInputs,
    });
  }

  const normalizedAsset = normalizeAssetConfig({ assetCode, assetIssuer });

  // Soroban fungible token contracts (SEP-41) use a "C..." contract address
  // as their issuer instead of a classic "G..." account. Validate that
  // shape up front so a malformed contract address fails fast with a clear
  // error instead of silently reaching Horizon or the metrics/JSON output.
  if (normalizedAsset.assetIssuer.startsWith('C')) {
    validateContractAddress(normalizedAsset.assetIssuer);
    // If the contract address format is strictly invalid, normalizeAssetConfig
    // would have already failed fast above. We still call validateContractAddress
    // here to ensure validation spans are consistently recorded.
    globalMetrics.recordContractMetric(
      'asset_issuer_contract_validated',
      1,
      normalizedAsset.assetIssuer,
      'count',
    );
  }

  const checkConfig: CheckConfig = {
    ...normalizedAsset,
    minXlmReserve: Number(minXlmReserve),
    minTrustlineLimit,
    horizonUrl,
    homeDomainCheckEnabled,
    expectedHomeDomain,
    homeDomainCheckMode,
    checkLedgerFreshness: checkLedgerFreshnessEnabled,
    maxLedgerLagSeconds,
    ledgerFreshnessFailOnStale,
  };

  core.info(`Checking Stellar account ${resolvedAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Ledger freshness / lag guard (Issue #107)
  // Run before the account fetch so a stale Horizon is flagged before we trust
  // the balance/trustline data it returns.
  // ---------------------------------------------------------------------------
  let freshnessResult: LedgerFreshnessCheckResult | undefined;
  if (checkLedgerFreshnessEnabled) {
    core.info(`Checking ledger freshness (max lag: ${maxLedgerLagSeconds}s)…`);
    try {
      const raw = await checkLedgerFreshness(horizonUrl, {
        maxLagSeconds: maxLedgerLagSeconds,
        timeoutMs: Math.min(horizonTimeoutMs, 10_000),
      });

      freshnessResult = {
        status: raw.status,
        lagSeconds: raw.lagSeconds,
        latestLedger: raw.latestLedger,
        message: raw.message,
        blocksValid: raw.status === 'stale' && ledgerFreshnessFailOnStale,
      };

      if (raw.status === 'stale') {
        const logMsg = `Ledger freshness check: STALE — ${raw.message}`;
        if (ledgerFreshnessFailOnStale) {
          core.error(logMsg);
        } else {
          core.warning(logMsg);
        }
      } else if (raw.status === 'unknown') {
        core.warning(`Ledger freshness check: UNKNOWN — ${raw.message}`);
      } else {
        core.info(`Ledger freshness check: OK — ${raw.message}`);
      }
    } catch (freshnessError) {
      // Fail-open: a freshness check error never blocks the account check.
      const msg = getErrorMessage(freshnessError);
      core.warning(`Ledger freshness check failed (proceeding fail-open): ${msg}`);
      freshnessResult = {
        status: 'unknown',
        lagSeconds: null,
        latestLedger: null,
        message: `Freshness check error: ${msg}. Proceeding (fail-open).`,
        blocksValid: false,
      };
    }
  }

  let result;
  
  const rateBudgetTracker = new RateBudgetTracker(horizonMaxRequests);

  const horizonOptions = {
    timeoutMs: horizonTimeoutMs,
    horizonUrlFallback: horizonUrlFallback || undefined,
    fallbackUrls,
    cacheTtlMs: useCache ? horizonCacheTtlMs : 0,
    useCache,
    allowCrossNetworkFallback,
    rateBudgetTracker,
    horizonMaxRequests,
  };

  try {
    const account = waitUntilFunded
      ? await waitForFundedAccount(
          horizonUrl,
          resolvedAddress,
          {
            timeoutMs: waitUntilFundedTimeoutMs,
            pollIntervalMs: waitUntilFundedIntervalMs,
            requestTimeoutMs: horizonTimeoutMs,
            signal: jobController.signal,
            onPoll: (attempt, elapsedMs) =>
              logger.debug(`Account not yet funded — polling again`, {
                component: 'index',
                attempt,
                elapsedMs,
              }),
          },
          (hUrl, sAddr, opts) => fetchAccount(hUrl, sAddr, { ...horizonOptions, ...opts }),
        )
      : await fetchAccount(horizonUrl, resolvedAddress, horizonOptions);
    result = runAccountChecks(account, checkConfig);
  } catch (error) {
    globalMetrics.stopTimer('horizon_fetch');
    if (error instanceof HorizonError && error.statusCode === 404) {
      // #144: attempt cross-network detection before building the result so
      // the comment surfaces a clear mismatch error when the address is active
      // on the opposite network. Fire-and-forget with a short timeout so a
      // slow alt-network Horizon never blocks the primary run.
      const mismatchHint = await detectNetworkMismatch(horizonUrl, stellarAddress).catch(
        () => undefined,
      );
      if (mismatchHint) {
        core.warning(
          `Cross-network mismatch detected: address is active on ${mismatchHint.activeOnNetwork} ` +
          `but horizon_url points at ${mismatchHint.configuredNetwork}.`,
        );
      }
      result = unfundedAccountResult(stellarAddress, checkConfig, mismatchHint);
    } else if (error instanceof HorizonError) {
      core.error(error.message);
      globalMetrics.incrementCounter('errors');
      globalMetrics.recordMetric('horizon_error', error.statusCode, 'http_status');
      result = horizonFailureResult(error.message, checkConfig);
    } else {
      const message = getErrorMessage(error);
      core.error(message);
      globalMetrics.incrementCounter('errors');
      result = horizonFailureResult(message, checkConfig);
    }
  } finally {
    // Ensure the controller is not leaked if the function returns early.
    jobController.abort();
  }

  // result is undefined only when the run was cancelled and we returned early above.
  if (result == null) {
    return;
  }

  // Attach the freshness result to every result path so comment.ts can render it.
  if (freshnessResult !== undefined) {
    result = { ...result, ledgerFreshnessResult: freshnessResult };
    // When stale AND fail-on-stale is enabled, override valid so the gate fires.
    if (freshnessResult.blocksValid && result.valid) {
      result = { ...result, valid: false };
    }
  }

  setValidationOutputs(result);

  if (writeValidationJsonEnabled) {
    writeValidationJson({
      result,
      stellarAddress: resolvedAddress,
      assetCode: effectiveAssetCode,
      assetIssuer: effectiveAssetIssuer,
      horizonUrl: effectiveHorizonUrl,
      outputPath: validationJsonPath,
      privacyMode,
    });
    core.info(`Wrote validation JSON artifact to ${validationJsonPath}`);
  }

  // Reserved inputs kept for forward-compatible workflows / labels / Soroban.
  logger.debug('Optional feature flags', {
    component: 'index',
    autoWalletLabels,
    sorobanRpcUrl: sorobanRpcUrl || undefined,
    contractId: contractId || undefined,
    githubUsername: githubUsername || undefined,
    trustbridgeConfigPath,
  });

  const previousArtifact = loadPreviousValidationArtifact(previousValidationPath);
  const delta = computeValidationDelta(previousArtifact, result);
  if (!previousArtifact && previousValidationPath.trim()) {
    core.info(
      'No previous validation artifact found — omitting delta (first run or missing download).',
    );
  } else if (delta) {
    core.info(
      `Validation delta vs previous run: newlyPassed=${delta.newlyPassed.length}, newlyFailed=${delta.newlyFailed.length}, unchanged=${delta.unchanged.length}`,
    );
  }

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress: resolvedAddress,
    horizonUrl,
    failOnMissing,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    onboardingChecklist,
    sep0007DeepLinks,
    sep0007OriginDomain,
    locale,
    debugMode,
    docsBaseUrl: core.getInput('docs_base_url') || undefined,
  });

  // Detect oversize and write the full report to a workspace file when needed.
  const commentBodyBytes = Buffer.byteLength(commentBody, 'utf8');
  let fullReportPath: string | undefined;
  let effectiveCommentBody: string;

  if (commentBodyBytes > COMMENT_SIZE_LIMIT_BYTES) {
    core.warning(
      `Comment body is ${commentBodyBytes} bytes, which exceeds GitHub's ${COMMENT_SIZE_LIMIT_BYTES}-byte limit. ` +
        `Writing full report to ${reportOutputPath} and posting a truncated comment instead.`,
    );
    fullReportPath = writeFullReport(commentBody, reportOutputPath);
    effectiveCommentBody = buildTruncatedCommentBody(commentBody, reportOutputPath);
  } else {
    effectiveCommentBody = commentBody;
  }

  let commentUrl: string | undefined;
  if (!shouldPostComment) {
    core.info(
      `comment_mode=${commentMode} — skipping issue comment post (outputs still set).`,
    );
  } else if (discussionNodeId) {
    // Discussion events carry a GraphQL node id, not an issue number —
    // comment via GraphQL, never the REST issues API (Issue #221).
    try {
      commentUrl = await postDiscussionComment(githubToken, effectiveCommentBody, {
        sticky: stickyComment,
        forceComment,
        snoozeWindowMs,
      });
      if (commentUrl) {
        logger.info('Discussion comment created', { component: 'index', commentUrl });
      } else {
        logger.info('No discussion comment posted (no discussion context).', {
          component: 'index',
        });
      }
    } catch (commentError) {
      const message = commentError instanceof Error ? commentError.message : String(commentError);
      core.warning(`Failed to post discussion comment (non-fatal): ${message}`);
    }
  } else {
    try {
      commentUrl = await postIssueComment(githubToken, effectiveCommentBody, {
        sticky: stickyComment,
        forceComment,
        snoozeWindowMs,
      });
      if (commentUrl) {
        logger.info('Issue comment created', { component: 'index', commentUrl });
      }
    } catch (commentError) {
      const message = commentError instanceof Error ? commentError.message : String(commentError);
      core.warning(`Failed to post issue comment (non-fatal): ${message}`);
    }
  }

  setValidationOutputs(result, commentUrl, fullReportPath);

  // Signed dashboard webhook notification (Issue #101)
  // Fires after comment posting; failures are isolated and never block the run.
  if (webhookUrl) {
    const { owner, repo } = github.context.repo;
    const issueNumber = github.context.payload.issue?.number ?? null;
    await sendWebhookNotification(
      result,
      resolvedAddress,
      { webhookUrl, webhookSecret, timeoutMs: webhookTimeoutMs },
      `${owner}/${repo}`,
      issueNumber,
    );
  }

  if (debugMode) {
    logger.debug('Metrics summary (JSON artifact)', { component: 'metrics' });
    core.debug(globalMetrics.toJSON());

    // Emit validation spans for observability (Issue #35)
    const spans = getSpans();
    if (spans.length > 0) {
      logger.debug('Validation spans', { component: 'validation', spanCount: spans.length });
      core.debug(JSON.stringify(spans, null, 2));
    }
  }

  // Wave #27: write Job Summary with latency, failure codes, JSON artifact
  await writeJobSummary(globalMetrics.buildJobSummary());

  if (result.valid) {
    core.info('All TrustBridge checks passed.');
    return;
  }

  const summary = formatFailureSummary(result);

  const failureMessage = `TrustBridge checks failed: ${summary}`;

  if (effectiveFailOnMissing) {
    core.setFailed(failureMessage);
  } else {
    core.warning(failureMessage);
  }
}

// Skip auto-run under Jest so performance / integration tests can import `run`.
export { run };

if (process.env.JEST_WORKER_ID === undefined) {
  run().catch((error) => {
    core.setFailed(getErrorMessage(error));
  });
}
