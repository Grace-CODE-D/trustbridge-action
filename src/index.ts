import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  horizonFailureResult,
  parseMinAssetBalance,
  parseMinXlmReserve,
  runAccountChecks,
  tlsFailureResult,
  unfundedAccountResult,
  validateStellarAddress,
  extractStellarAddressFromText,
} from './checks';
import { fetchAccount, fetchNetworkPassphrase, HorizonError, waitForFundedAccount } from './horizon';
import { formatCommentBody, postIssueComment } from './comment';
import { normalizeAssetConfig } from './assets';
import {
  getErrorMessage,
  parseBooleanInput,
  parseNumberInput,
  parseUnauthorizedTrustlinePolicy,
} from './inputs';
import { formatFailureSummary } from './summary';
import { setValidationOutputs } from './outputs';
import { logger, emitInputsLogRecord } from './logger';
import { globalMetrics, writeJobSummary } from './metrics';
import { validateContractAddress, clearSpans, getSpans } from './validation';

async function run(): Promise<void> {
  const horizonUrl = core.getInput('horizon_url') || 'https://horizon.stellar.org';
  const assetCode = core.getInput('asset_code') || 'USDC';
  const assetIssuer =
    core.getInput('asset_issuer') ||
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const minXlmReserveRaw = core.getInput('min_xlm_reserve') || '1.5';
  const minAssetBalanceRaw = core.getInput('min_asset_balance') || '';
  const stellarAddress = core.getInput('stellar_address_input').trim();
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
  const logInputs = parseBooleanInput(core.getInput('log_inputs'), false);
  const networkPassphrase = core.getInput('network_passphrase') || 'Public Global Stellar Network ; September 2015';
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const trustbridgeConfigPath = core.getInput('trustbridge_config_path') || '.trustbridge.yml';
  const githubToken = core.getInput('github_token', { required: true });
  const autoWalletLabels = parseBooleanInput(core.getInput('auto_wallet_labels'), false);

  // SEP-0007 wallet deep links (Issue #44)
  const sep0007DeepLinks = parseBooleanInput(core.getInput('sep0007_deep_links'), false);
  const sep0007OriginDomain = core.getInput('sep0007_origin_domain') || '';

  // Wave #29: workflow_dispatch issue_number benchmark (Issue #29)
  const issueNumberRaw = core.getInput('issue_number') || '';
  const dispatchIssueNumber = issueNumberRaw.trim()
    ? parseNumberInput(issueNumberRaw.trim(), 0, { min: 1 })
    : undefined;

  // Wave #28: address extraction from issue body (Issue #28)
  const extractAddressFromIssue = parseBooleanInput(core.getInput('extract_address_from_issue'), false);

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
    trustbridgeConfigPath,
    horizonUrl,
    horizonUrlFallback,
    horizonCacheTtlMs,
    assetCode,
    assetIssuer,
    minXlmReserveRaw,
    minAssetBalanceRaw,
    debugMode,
    horizonTimeoutMs,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    rpcFallbackUrl: rpcFallbackUrlRaw,
    useCache,
    sep0007DeepLinks,
    extractAddressFromIssue,
    dispatchIssueNumber: dispatchIssueNumber ?? null,
  });

  // Wave #28: auto-extract Stellar address from the issue body when
  // `extract_address_from_issue` is true and no explicit address was given.
  let resolvedStellarAddress = stellarAddress;
  if (extractAddressFromIssue && !resolvedStellarAddress) {
    const issueBody = github.context.payload.issue?.body ?? '';
    const extraction = extractStellarAddressFromText(issueBody);
    if (extraction.address) {
      resolvedStellarAddress = extraction.address;
      logger.debug('Stellar address extracted from issue body', {
        component: 'index',
        stellarAddress: resolvedStellarAddress,
        totalFound: extraction.allAddresses.length,
      });
      core.info(`Extracted Stellar address from issue body: ${resolvedStellarAddress}`);
    } else {
      throw new Error(
        'extract_address_from_issue is true but no valid Stellar G-address was found in the issue body. ' +
        'Add a Stellar address to the issue body or supply stellar_address_input explicitly.',
      );
    }
  }

  if (logInputs) {
    emitInputsLogRecord({
      horizonUrl,
      horizonUrlFallback,
      rpcFallbackUrl: rpcFallbackUrlRaw,
      assetCode,
      assetIssuer,
      minXlmReserve: minXlmReserveRaw,
      minAssetBalance: minAssetBalanceRaw,
      stellarAddress,
      failOnMissing,
      debugMode,
      horizonTimeoutMs,
      stickyComment,
      waitUntilFunded,
      waitUntilFundedTimeoutMs,
      waitUntilFundedIntervalMs,
      horizonCacheTtlMs,
      useCache,
      logInputs,
    });
  }

  validateStellarAddress(resolvedStellarAddress);
  const minXlmReserve = parseMinXlmReserve(minXlmReserveRaw);
  const minAssetBalance = parseMinAssetBalance(minAssetBalanceRaw);

  // Reject clearly unsafe Horizon/RPC endpoints before ever attempting a
  // connection (Issue #71): private IPs, loopback, link-local, cloud
  // metadata endpoints, and file:// are all blocked. HTTPS is required —
  // plain HTTP Horizon endpoints are not supported in production defaults,
  // so TLS verification can never be silently bypassed by pointing at an
  // unencrypted mirror.
  const horizonUrlInputs: Array<[string, string]> = [['horizon_url', horizonUrl]];
  if (horizonUrlFallback) horizonUrlInputs.push(['horizon_url_fallback', horizonUrlFallback]);
  for (const fallbackUrl of fallbackUrls) {
    horizonUrlInputs.push(['rpc_fallback_url', fallbackUrl]);
  }
  for (const [fieldName, urlValue] of horizonUrlInputs) {
    const urlCheck = validateSsrfSafeUrl(urlValue, fieldName);
    if (!urlCheck.valid) {
      throw new Error(`Invalid ${fieldName}: ${urlCheck.errors.join('; ')}`);
    }
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
    minAssetBalance,
    horizonUrl,
    unauthorizedTrustlinePolicy,
    clawbackStrictMode,
  };

  core.info(`Checking Stellar account ${resolvedStellarAddress} via ${horizonUrl}`);

  if (waitUntilFunded) {
    core.info(
      `wait_until_funded is enabled — polling every ${waitUntilFundedIntervalMs}ms for up to ${waitUntilFundedTimeoutMs}ms.`,
    );
  }

  let result;

  const horizonOptions = {
    timeoutMs: horizonTimeoutMs,
    horizonUrlFallback: horizonUrlFallback || undefined,
    fallbackUrls,
    useCache,
    cacheTtlMs: horizonCacheTtlMs,
  };

  core.info(`Verifying network identity for ${horizonUrl}...`);
  const actualPassphrase = await fetchNetworkPassphrase(horizonUrl, horizonOptions);
  if (actualPassphrase !== networkPassphrase) {
    throw new Error(
      `Network identity mismatch. Expected "${networkPassphrase}" but Horizon returned "${actualPassphrase}". ` +
      `Check your horizon_url and network_passphrase inputs.`
    );
  }

  const PUBLIC_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  if (
    normalizedAsset.assetIssuer === PUBLIC_USDC_ISSUER &&
    actualPassphrase !== 'Public Global Stellar Network ; September 2015'
  ) {
    throw new Error(
      `Mismatched configuration: The asset_issuer is the Public Network USDC issuer, ` +
      `but the network_passphrase indicates a different network.`
    );
  }

  try {
    const account = waitUntilFunded
      ? await waitForFundedAccount(
          horizonUrl,
          resolvedStellarAddress,
          {
            timeoutMs: waitUntilFundedTimeoutMs,
            pollIntervalMs: waitUntilFundedIntervalMs,
            requestTimeoutMs: horizonTimeoutMs,
            onPoll: (attempt, elapsedMs) =>
              logger.debug(`Account not yet funded — polling again`, {
                component: 'index',
                attempt,
                elapsedMs,
              }),
          },
          (hUrl, sAddr, opts) => fetchAccount(hUrl, sAddr, { ...horizonOptions, ...opts }),
        )
      : await fetchAccount(horizonUrl, resolvedStellarAddress, horizonOptions);
    globalMetrics.stopTimer('horizon_fetch');
    result = runAccountChecks(account, checkConfig);
  } catch (error) {
    globalMetrics.stopTimer('horizon_fetch');
    if (error instanceof HorizonError && error.statusCode === 404) {
      result = unfundedAccountResult(resolvedStellarAddress, checkConfig);
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
  }

  setValidationOutputs(result);

  const commentBody = formatCommentBody(result, {
    ...checkConfig,
    stellarAddress: resolvedStellarAddress,
    horizonUrl,
    failOnMissing,
    stickyComment,
    waitUntilFunded,
    waitUntilFundedTimeoutMs,
    waitUntilFundedIntervalMs,
    sep0007DeepLinks,
    sep0007OriginDomain,
    debugMode,
  });

  let commentUrl: string | undefined;
  try {
    commentUrl = await postIssueComment(githubToken, commentBody, {
      sticky: stickyComment,
      issueNumber: dispatchIssueNumber,
    });
    if (commentUrl) {
      logger.info('Issue comment created', { component: 'index', commentUrl });
    }
  } catch (commentError) {
    const message = getErrorMessage(commentError);
    core.warning(`Failed to post issue comment: ${message}`);
  }

  setValidationOutputs(result, commentUrl);

  // Wave #31: auto wallet labels — apply wallet state label to the issue.
  const issueNumber = github.context.payload.issue?.number;
  if (autoWalletLabels && issueNumber) {
    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = github.context.repo;
    const isHorizonError =
      !result.accountFunded && result.xlmBalance === 'unknown';

    const labelResult = await globalOctokitMetrics.track(
      'issues.addLabels',
      async () => {
        const r = await applyWalletLabels(octokit, owner, repo, issueNumber, {
          accountFunded: result.accountFunded,
          trustlineExists: result.trustlineExists,
          xlmReserveMet: result.xlmReserveMet,
          horizonError: isHorizonError,
        });
        return { status: r.error ? 422 : 200, headers: {}, data: r };
      },
    );

    if (labelResult.data.error) {
      core.warning(`Auto wallet label failed: ${labelResult.data.error}`);
    } else {
      logger.info(`Wallet label applied: ${labelResult.data.applied}`, {
        component: 'index',
        applied: labelResult.data.applied,
        removed: labelResult.data.removed.length,
      });
    }
  }

  // Wave #37: emit Octokit metrics JSON artifact in debug mode.
  if (debugMode) {
    logger.debug('Octokit metrics summary (JSON artifact)', { component: 'metrics' });
    core.debug(globalOctokitMetrics.toJSON());
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

  if (failOnMissing) {
    core.setFailed(failureMessage);
  } else {
    core.warning(failureMessage);
  }
}

run().catch((error) => {
  core.setFailed(getErrorMessage(error));
});
