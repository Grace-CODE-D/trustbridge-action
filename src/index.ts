import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  detectNetworkMismatch,
  horizonFailureResult,
  parseMinAssetBalance,
  parseMinXlmReserve,
  runAccountChecks,
  runMultiAssetChecks,
  AssetTrustlineResult,
  unfundedAccountResult,
  validateStellarAddress,
  buildValidationGate,
  ValidationResult,
  HomeDomainCheckMode,
} from './checks';
import { fetchAccount, HorizonError, waitForFundedAccount } from './horizon';
import { formatCommentBody, postIssueComment, COMMENT_SIZE_LIMIT_BYTES, buildTruncatedCommentBody, writeFullReport } from './comment';
import { normalizeAssetConfig } from './assets';
import {
  getErrorMessage,
  parseAssigneeAddressMap,
  parseBooleanInput,
  parseNumberInput,
  resolveAddressFromAssigneeMap,
} from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs, writeValidationJson } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';
import { parseLocaleInput } from './i18n';

async function run(): Promise<void> {
  const horizonUrl = core.getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || 'USDC';
  const assetIssuer =
    getInput('asset_issuer') ||
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
  const stickyComment = parseBooleanInput(getInput('sticky_comment'), true);
  const waitUntilFunded = parseBooleanInput(getInput('wait_until_funded'), false);
  const waitUntilFundedTimeoutMs = parseNumberInput(
    getInput('wait_until_funded_timeout_ms'),
    120000,
    { min: 0, max: 600000 },
  );
  const waitUntilFundedIntervalMs = parseNumberInput(
    getInput('wait_until_funded_interval_ms'),
    5000,
    { min: 1000, max: 60000 },
  );
  const horizonUrlFallback = getInput('horizon_url_fallback') || '';
  const rpcFallbackUrlRaw = getInput('rpc_fallback_url') || '';
  const fallbackUrls = rpcFallbackUrlRaw
    ? rpcFallbackUrlRaw.split(',').map((u) => u.trim()).filter(Boolean)
    : horizonUrlFallback
      ? [horizonUrlFallback]
      : [];
  const horizonCacheTtlMs = parseNumberInput(getInput('horizon_cache_ttl_ms'), 60000, {
    min: 0,
    max: 3_600_000,
  });
  const useCache = parseBooleanInput(core.getInput('use_cache'), false);
  const allowCrossNetworkFallback = parseBooleanInput(
    core.getInput('allow_cross_network_fallback'),
    false,
  );
  const logInputs = parseBooleanInput(core.getInput('log_inputs'), false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const trustbridgeConfigPath = core.getInput('trustbridge_config_path') || '.trustbridge.yml';
  const githubToken = core.getInput('github_token', { required: true });
  const autoWalletLabels = parseBooleanInput(core.getInput('auto_wallet_labels'), false);

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = getInput('sep0007_origin_domain') || '';

  // #145 — issues:write preflight
  const preflightOnly = parseBooleanInput(getInput('preflight_only'), false);

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

  // SEP-0001 home domain check inputs (optional, off by default)
  const homeDomainCheckEnabled = parseBooleanInput(core.getInput('home_domain_check_enabled'), false);
  const expectedHomeDomain = core.getInput('expected_home_domain').trim() || undefined;
  const homeDomainCheckModeRaw = core.getInput('home_domain_check_mode').trim().toLowerCase();
  const homeDomainCheckMode: HomeDomainCheckMode =
    homeDomainCheckModeRaw === 'strict' ? 'strict' : 'warn';

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
    minXlmReserve,
    minTrustlineLimit,
    horizonUrl,
    homeDomainCheckEnabled,
    expectedHomeDomain,
    homeDomainCheckMode,
  };

  core.info(`Checking Stellar account ${resolvedAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
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

  setValidationOutputs(result);

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
  try {
    commentUrl = await postIssueComment(githubToken, commentBody, { 
      sticky: stickyComment,
      forceComment,
      snoozeWindowMs,
    });
    if (commentUrl) {
      logger.info('Issue comment created', { component: 'index', commentUrl });
    }
  } else {
    logger.info(`Comment posting skipped (comment_mode=${commentMode})`, {
      component: 'index',
      commentMode,
    });
  }

  setValidationOutputs(result, commentUrl, fullReportPath);

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
if (process.env.JEST_WORKER_ID === undefined) {
  run().catch((error) => {
    core.setFailed(getErrorMessage(error));
  });
}
