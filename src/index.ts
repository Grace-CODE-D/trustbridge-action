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
} from './checks';
import { fetchAccount, HorizonError, waitForFundedAccount } from './horizon';
import { RateBudgetTracker } from './resilience';
import { formatCommentBody, postIssueComment } from './comment';
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
    trustbridgeConfigPath,
    sep0007DeepLinks,
    onboardingChecklist,
    trustbridgeConfigPath,
  });

  validateStellarAddress(stellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);
  const minTrustlineLimitRaw = core.getInput('min_trustline_limit') || '';
  const minTrustlineLimit = minTrustlineLimitRaw ? parseNumberInput(minTrustlineLimitRaw, 0, { min: 0 }) : undefined;

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
    retryMaxDelayMs,
    retryMaxTotalWaitMs,
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

  let commentUrl: string | undefined;

  // Wave #30: skip comment posting in dry-run and off modes
  const shouldPostComment = commentMode === 'post';

  if (shouldPostComment) {
    try {
      commentUrl = await postIssueComment(githubToken, commentBody, { sticky: stickyComment });
      if (commentUrl) {
        logger.info('Issue comment created', { component: 'index', commentUrl });
      }
    } catch (commentError) {
      const message = getErrorMessage(commentError);
      core.warning(`Failed to post issue comment: ${message}`);
    }
  } else {
    logger.info(`Comment posting skipped (comment_mode=${commentMode})`, {
      component: 'index',
      commentMode,
    });
  }

  setValidationOutputs(result, commentUrl, multiAssetResults);

  // Wave #38: POST validation summary to dashboard webhook (if configured)
  if (dashboardWebhookUrl) {
    try {
      await postDashboardWebhook(dashboardWebhookUrl, {
        result,
        config: checkConfig,
        stellarAddress,
        commentMode,
        commentUrl,
      });
      logger.info('Dashboard webhook delivered', {
        component: 'index',
        webhookUrl: redactHorizonUrl(dashboardWebhookUrl),
      });
    } catch (webhookError) {
      const message = getErrorMessage(webhookError);
      core.warning(`Failed to POST dashboard webhook: ${message}`);
    }
  }

  if (shouldWriteValidationJson) {
    try {
      writeValidationJson(result, { ...checkConfig, stellarAddress }, validationJsonPath);
    } catch (error) {
      core.warning(`Failed to write validation.json: ${getErrorMessage(error)}`);
    }
  }

  if (writeValidationJsonEnabled) {
    try {
      writeValidationJson({
        result,
        stellarAddress,
        assetCode: normalizedAsset.assetCode,
        assetIssuer: normalizedAsset.assetIssuer,
        horizonUrl,
        outputPath: validationJsonPath,
        delta,
        privacyMode,
      });
    } catch (error) {
      core.warning(`Failed to write validation.json: ${getErrorMessage(error)}`);
    }
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
if (process.env.JEST_WORKER_ID === undefined) {
  run().catch((error) => {
    core.setFailed(getErrorMessage(error));
  });
}
