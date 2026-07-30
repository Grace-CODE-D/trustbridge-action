import { defaultCache, SimpleCache } from './cache';
import { logger, redactHorizonUrl, redactString, LogContext } from './logger';
import { inferStellarNetwork } from './links';
export interface HorizonBalanceNative {
  balance: string;
  asset_type: 'native';
  buying_liabilities: string;
  selling_liabilities: string;
}

export interface HorizonBalanceCredit {
  balance: string;
  asset_type: 'credit_alphanum4' | 'credit_alphanum12';
  asset_code: string;
  asset_issuer: string;
  buying_liabilities: string;
  selling_liabilities: string;
  limit?: string; // Maximum balance this trustline can hold (Issue #140)
}

export interface HorizonBalanceLiquidityPoolShares {
  balance: string;
  asset_type: 'liquidity_pool_shares';
  liquidity_pool_id: string;
  buying_liabilities: string;
  selling_liabilities: string;
  limit: string;
  is_authorized: boolean;
  is_authorized_to_maintain_liabilities: boolean;
}

export interface HorizonBalanceClaimable {
  asset_type: 'claimable_balance_id';
  balance: string;
  claimable_balance_id: string;
}

export type HorizonBalance =
  | HorizonBalanceNative
  | HorizonBalanceCredit
  | HorizonBalanceLiquidityPoolShares
  | HorizonBalanceClaimable;

export interface HorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  subentry_count: number;
  balances: HorizonBalance[];
  num_sponsoring: number;
  num_sponsored: number;
  _servedByUrl?: string;
}

export interface HorizonErrorResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

export class HorizonError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'HorizonError';
  }
}

export class HorizonRateLimitError extends HorizonError {
  constructor(message: string, public readonly retryAfterMs?: number) {
    super(message, 429, true);
    this.name = 'HorizonRateLimitError';
  }
}

type FetchLike = (
  url: string | import('node-fetch').Request,
  init?: import('node-fetch').RequestInit,
) => Promise<import('node-fetch').Response>;

export interface FetchAccountOptions {
  timeoutMs?: number;
  maxRetries?: number;
  horizonUrlFallback?: string;
  secondaryHorizonUrl?: string;
  fallbackUrls?: string[];
  allowCrossNetworkFailover?: boolean;
  useCache?: boolean;
  cacheTtlMs?: number;
  cache?: SimpleCache;
  fetchFn?: FetchLike;
  /**
   * By default, a fallback URL that resolves to a *different* Stellar
   * network than the primary `horizon_url` (public vs testnet, inferred
   * from the URL) is never used — a G-address is valid on every network,
   * so a cross-network fallback can silently return funded/trustline/
   * reserve data for the wrong ledger instead of failing loudly. Set this
   * to `true` to opt into cross-network fallback anyway (e.g. deliberate
   * multi-network setups).
   */
  allowCrossNetworkFallback?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_RETRY_MAX_TOTAL_WAIT_MS = 120_000;

export function normalizeHorizonUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return '';
  }
  const validation = validateHorizonUrl(trimmed, 'horizon_url', { allowHttp: true });
  if (!validation.valid) {
    throw new HorizonError(`Invalid horizon_url: ${validation.errors.join('; ')}`, 400, false);
  }
  const parsed = new URL(trimmed);
  const cleanPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

/**
 * Produce a representation of a configured Horizon URL that is safe to
 * post in a public-facing GitHub issue comment. A private Horizon mirror's
 * hostname can itself be sensitive internal infrastructure information, so
 * by default only the URL scheme is shown. Pass `revealHost: true` (wired
 * to the `debug_mode` input) to show the full host — still routed through
 * `redactHorizonUrl` so any embedded account address stays masked.
 */
export function displayHorizonUrl(url: string, revealHost: boolean): string {
  if (!url) return url;
  if (revealHost) {
    return redactHorizonUrl(url);
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//••• (set debug_mode: true to reveal)`;
  } catch {
    return '••• (set debug_mode: true to reveal)';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 502 || status === 504;
}

export function parseRetryAfterMs(response: import('node-fetch').Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for `ms` milliseconds, but resolve immediately (without throwing) if
 * `signal` is aborted before the timer fires.  The caller is responsible for
 * checking `signal.aborted` after the await if it needs to stop on cancellation.
 */
function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildCacheKey(normalizedHorizonUrl: string, stellarAddress: string): string {
  return `horizon:account:${normalizedHorizonUrl}:${stellarAddress}`;
}

function redactCacheKey(key: string): string {
  return redactString(key);
}

function redactCacheStats(stats: { size: number; entries: string[] }): {
  size: number;
  entries: string[];
} {
  return {
    size: stats.size,
    entries: stats.entries.map(redactCacheKey),
  };
}

/**
 * Record a cache hit/miss metric point. The `horizonUrl` and
 * `stellarAddress` tags carry the same key dimensions as the cache entry
 * itself (see `buildCacheKey`), so metrics can be sliced per matrix leg
 * (e.g. per Horizon endpoint) — but the address is redacted first-4/last-4
 * so the metric export never leaks a full contributor address, matching
 * the redaction policy used everywhere else in this module.
 */
function recordCacheMetric(
  outcome: 'hit' | 'miss',
  normalizedHorizonUrl: string,
  stellarAddress: string,
): void {
  globalMetrics.recordMetric(`horizon_cache_${outcome}`, 1, 'count', {
    horizonUrl: redactHorizonUrl(normalizedHorizonUrl),
    stellarAddress: redactStellarAddress(stellarAddress),
  });
  globalMetrics.incrementCounter(`horizon_cache_${outcome}`);
}

function safeHorizonContext(
  base: Omit<LogContext, 'stellarAddress' | 'horizonUrl'> & {
    stellarAddress: string;
    horizonUrl: string;
    horizonUrlFallback?: string;
    cacheKey?: string;
  },
): LogContext {
  const ctx: LogContext = { ...base };
  if (base.horizonUrlFallback) {
    ctx.horizonUrlFallback = redactHorizonUrl(base.horizonUrlFallback);
  }
  if (base.cacheKey) {
    ctx.cacheKey = redactCacheKey(base.cacheKey);
  }
  return ctx;
}

/**
 * Snapshot of non-sensitive account fields that are safe to include in a
 * debug log. Never include balance values, sequence numbers, sponsor
 * counts, or the raw account_id — only aggregate structural data, plus
 * the redacted address via `stellarAddress` on the surrounding context.
 */
function safeAccountSummary(account: HorizonAccount): {
  balancesCount: number;
  hasNativeBalance: boolean;
  creditTrustlineCount: number;
  subentryCount: number;
} {
  return {
    balancesCount: account.balances.length,
    hasNativeBalance: account.balances.some((b) => b.asset_type === 'native'),
    creditTrustlineCount: account.balances.filter((b) => isCreditBalance(b)).length,
    subentryCount: account.subentry_count,
  };
}

interface FetchOnceResult {
  account: HorizonAccount;
  statusCode: number;
  latencyMs: number;
  attempts: number;
}

async function fetchAccountOnce(
  fetch: FetchLike,
  targetHorizonUrl: string,
  stellarAddress: string,
  timeoutMs: number,
  maxRetries: number,
  endpointKind: 'primary' | 'fallback',
  retryMaxDelayMs: number,
  retryMaxTotalWaitMs: number,
): Promise<FetchOnceResult> {
  const normalizedHorizonUrl = normalizeHorizonUrl(targetHorizonUrl);
  const url = `${normalizedHorizonUrl}/accounts/${stellarAddress}`;
  const safeUrlForLog = redactHorizonUrl(url);

  let attempt = 0;
  let totalWaitMs = 0;
  let lastError: Error | undefined;

  while (attempt <= maxRetries) {
    // Bail out immediately if the job was cancelled before this attempt.
    if (parentSignal?.aborted) {
      throw new HorizonError('Horizon request aborted (job cancelled).', 0, false);
    }

    const requestStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Propagate the parent cancellation signal to the per-request controller.
    let parentAbortHandler: (() => void) | undefined;
    if (parentSignal) {
      parentAbortHandler = () => controller.abort();
      parentSignal.addEventListener('abort', parentAbortHandler);
    }

    logger.debug('Horizon fetch start', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl: targetHorizonUrl,
      endpointKind,
      attempt,
      maxAttempts: maxRetries + 1,
      timeoutMs,
      url: safeUrlForLog,
    }));

    try {
      if (rateBudgetTracker) {
        rateBudgetTracker.recordRequest();
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      const latencyMs = Date.now() - requestStartedAt;

      if (response.status === 404) {
        logger.debug('Horizon account not found (404)', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          status: 404,
          latencyMs,
          attempt,
        }));
        throw new HorizonError(
          `Account ${stellarAddress} was not found on Horizon (not funded or activated).`,
          404,
          false,
        );
      }

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        let detail = response.statusText;
        try {
          const body = (await response.json()) as HorizonErrorResponse;
          if (body.detail) {
            detail = body.detail;
          } else if (body.title) {
            detail = body.title;
          }
          logger.debug('Horizon error response parsed', safeHorizonContext({
            component: 'horizon',
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            errorDetail: redactString(detail),
            errorType: body.type ? redactString(body.type) : undefined,
            errorTitle: body.title ? redactString(body.title) : undefined,
          }));
        } catch {
          logger.debug('Horizon error response missing JSON body', safeHorizonContext({
            component: 'horizon',
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            statusText: response.statusText,
          }));
        }

        if (retryable && attempt < maxRetries) {
          const retryAfterHeader = parseRetryAfterMs(response);
          const retryAfter = retryAfterHeader ?? 1000 * 2 ** attempt;
          
          if (retryAfter > retryMaxDelayMs || totalWaitMs + retryAfter > retryMaxTotalWaitMs) {
             throw new HorizonRateLimitError(
               `Horizon rate limit exceeded (Retry-After ${retryAfter}ms exceeds cap of ${retryMaxDelayMs}ms per-retry or ${retryMaxTotalWaitMs}ms total). Please try again later.`,
               retryAfter
             );
          }
          
          totalWaitMs += retryAfter;

          logger.debug('Horizon retry scheduled', safeHorizonContext({
            component: 'horizon',
            stellarAddress,
            horizonUrl: targetHorizonUrl,
            endpointKind,
            status: response.status,
            retryable,
            latencyMs,
            attempt,
            retryAfterMs: retryAfter,
            retryAfterFromHeader: retryAfterHeader !== null,
            nextAttempt: attempt + 1,
          }));
          await cancellableSleep(retryAfter, parentSignal);
          // If the job was cancelled during the sleep, bail out on the next
          // iteration's pre-flight check rather than issuing another request.
          attempt += 1;
          continue;
        }

        logger.debug('Horizon non-retryable HTTP error (exhausted retries)', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          status: response.status,
          retryable,
          latencyMs,
          attempt,
          final: true,
        }));

        throw new HorizonError(
          `Horizon request failed (${response.status}): ${detail}`,
          response.status,
          retryable,
        );
      }

      const parsed = (await response.json()) as HorizonAccount;
      logger.debug('Horizon fetch success', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        status: response.status,
        latencyMs,
        attempt,
        ...safeAccountSummary(parsed),
      }));
      return {
        account: parsed,
        statusCode: response.status,
        latencyMs,
        attempts: attempt + 1,
      };
    } catch (error) {
      if (error instanceof HorizonError || (error instanceof Error && error.name === 'RateBudgetExhaustedError')) {
        throw error;
      }

      const tlsCode = tlsErrorCode(error);
      if (tlsCode) {
        const tlsLatencyMs = Date.now() - requestStartedAt;
        logger.debug('Horizon TLS/certificate verification failed', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          tlsErrorCode: tlsCode,
          latencyMs: tlsLatencyMs,
          attempt,
          final: true,
        }));
        // Not retryable: retrying against the same endpoint cannot fix a
        // bad certificate, so fail fast instead of burning the retry budget.
        throw new HorizonTlsError(
          'TLS/certificate verification failed while connecting to the configured Horizon endpoint. ' +
            'This is a transport-layer problem with the endpoint itself, not with the Stellar account being checked.',
          tlsCode,
        );
      }

      const isAbort = error instanceof Error && error.name === 'AbortError';
      // If the parent job signal fired, propagate as a non-retryable cancellation.
      const isJobCancelled = isAbort && parentSignal?.aborted;
      const message = isJobCancelled
        ? 'Horizon request aborted (job cancelled).'
        : isAbort
          ? `Horizon request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : 'Unknown Horizon error';

      const latencyMs = Date.now() - requestStartedAt;

      logger.debug('Horizon transport error', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        kind: isJobCancelled ? 'cancelled' : isAbort ? 'timeout' : 'network',
        latencyMs,
        attempt,
        timeoutMs,
        errorMessage: redactString(message),
      }));

      // Job cancellation is non-retryable — throw immediately.
      if (isJobCancelled) {
        throw new HorizonError(message, 0, false);
      }

      lastError = new HorizonError(message, isAbort ? 408 : 0, true);

      if (attempt < maxRetries) {
        const backoffMs = 1000 * 2 ** attempt;
        
        if (backoffMs > retryMaxDelayMs || totalWaitMs + backoffMs > retryMaxTotalWaitMs) {
          throw lastError;
        }
        
        totalWaitMs += backoffMs;

        logger.debug('Horizon transport retry scheduled', safeHorizonContext({
          component: 'horizon',
          stellarAddress,
          horizonUrl: targetHorizonUrl,
          endpointKind,
          kind: isAbort ? 'timeout' : 'network',
          latencyMs,
          attempt,
          retryAfterMs: backoffMs,
          nextAttempt: attempt + 1,
        }));
        await cancellableSleep(backoffMs, parentSignal);
        // If the job was cancelled during the backoff sleep, bail out on the
        // next iteration's pre-flight check rather than issuing another request.
        attempt += 1;
        continue;
      }

      logger.debug('Horizon transport error (exhausted retries)', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl: targetHorizonUrl,
        endpointKind,
        kind: isAbort ? 'timeout' : 'network',
        latencyMs,
        attempt,
        final: true,
      }));

      throw lastError;
    } finally {
      clearTimeout(timer);
      if (parentSignal && parentAbortHandler) {
        parentSignal.removeEventListener('abort', parentAbortHandler);
      }
    }
  }

  logger.debug('Horizon retry loop exited without result (fallback throw)', safeHorizonContext({
    component: 'horizon',
    stellarAddress,
    horizonUrl: targetHorizonUrl,
    endpointKind,
    maxAttempts: maxRetries + 1,
  }));

  throw lastError ?? new HorizonError('Horizon request failed after retries', 0, true);
}

export async function fetchAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: FetchAccountOptions = {},
): Promise<HorizonAccount> {
  const fetch: FetchLike =
    options.fetchFn ?? (await import('node-fetch')).default;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const retryMaxTotalWaitMs = options.retryMaxTotalWaitMs ?? DEFAULT_RETRY_MAX_TOTAL_WAIT_MS;
  const cache = options.cache ?? defaultCache;
  const horizonMaxRequests = options.horizonMaxRequests ?? 0;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 30000;
  
  const rateBudgetTracker = options.rateBudgetTracker ?? new RateBudgetTracker(horizonMaxRequests);
  const normalizedHorizonUrl = normalizeHorizonUrl(horizonUrl);
  const candidateFallbacks = [
    options.secondaryHorizonUrl,
    options.horizonUrlFallback,
    ...(options.fallbackUrls ?? []),
  ].filter((u): u is string => Boolean(u && u.trim()));

  const fallbackCandidate = candidateFallbacks[0];
  const normalizedFallbackUrl = fallbackCandidate
    ? normalizeHorizonUrl(fallbackCandidate)
    : '';

  if (!normalizedHorizonUrl) {
    throw new HorizonError('horizon_url is required.', 0, false);
  }

  // Bail out immediately if the job was already cancelled before we start.
  if (signal?.aborted) {
    throw new HorizonError('Horizon request aborted (job cancelled).', 0, false);
  }

  const cachingEnabled = cacheTtlMs > 0;
  const cacheKey = cachingEnabled
    ? buildCacheKey(normalizedHorizonUrl, stellarAddress)
    : '';

  if (cachingEnabled) {
    const cacheStatsBefore = redactCacheStats(cache.getStats());
    logger.debug('Horizon cache lookup start', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      cacheKey,
      cacheTtlMs,
      cacheSizeBefore: cacheStatsBefore.size,
      cacheEntryCountBefore: cacheStatsBefore.entries.length,
    }));

    const cached = cache.get<HorizonAccount>(cacheKey);
    if (cached) {
      logger.debug('Horizon cache hit', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        cacheKey,
        cacheTtlMs,
        ...safeAccountSummary(cached),
      }));
      recordCacheMetric('hit', normalizedHorizonUrl, stellarAddress);
      return cached;
    }

    logger.debug('Horizon cache miss', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      cacheKey,
      cacheTtlMs,
    }));
    recordCacheMetric('miss', normalizedHorizonUrl, stellarAddress);
  } else {
    logger.debug('Horizon cache disabled (ttl=0)', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      cacheTtlMs: 0,
    }));
  }

  let primaryError: HorizonError | undefined;

  try {
    const result = await fetchAccountOnce(
      fetch,
      normalizedHorizonUrl,
      stellarAddress,
      timeoutMs,
      maxRetries,
      'primary',
      retryMaxDelayMs,
      retryMaxTotalWaitMs,
    );

    result.account._servedByUrl = normalizedHorizonUrl;

    if (cachingEnabled) {
      cache.set(cacheKey, result.account, cacheTtlMs);
      const cacheStatsAfter = redactCacheStats(cache.getStats());
      logger.debug('Horizon cache populate after primary success', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        cacheKey,
        cacheTtlMs,
        cacheSizeAfter: cacheStatsAfter.size,
        cacheEntryCountAfter: cacheStatsAfter.entries.length,
        source: 'primary',
        ...safeAccountSummary(result.account),
      }));
    }

    return result.account;
  } catch (error) {
    if (error instanceof HorizonError) {
      primaryError = error;
      if (error.statusCode === 404) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (!normalizedFallbackUrl) {
    throw primaryError;
  }

  const primaryNetwork = inferStellarNetwork(normalizedHorizonUrl);
  const fallbackNetwork = inferStellarNetwork(normalizedFallbackUrl);
  if (primaryNetwork !== fallbackNetwork && !options.allowCrossNetworkFailover) {
    logger.debug('Horizon RPC fallback prevented: cross-network mismatch (mainnet vs testnet)', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      primaryNetwork,
      fallbackNetwork,
    }));
    throw primaryError;
  }

  logger.debug('Horizon RPC fallback: primary exhausted, switching to fallback URL', safeHorizonContext({
    component: 'horizon',
    stellarAddress,
    horizonUrl,
    horizonUrlFallback: normalizedFallbackUrl,
    cacheKey: cachingEnabled ? cacheKey : undefined,
    primaryNetwork,
    fallbackNetwork,
    crossNetworkFallback,
    primaryStatusCode: primaryError?.statusCode,
    primaryRetryable: primaryError?.retryable,
    primaryErrorMessage: primaryError ? redactString(primaryError.message) : undefined,
  }));

  try {
    const fallbackResult = await fetchAccountOnce(
      fetch,
      normalizedFallbackUrl,
      stellarAddress,
      timeoutMs,
      maxRetries,
      'fallback',
      retryMaxDelayMs,
      retryMaxTotalWaitMs,
    );

    fallbackResult.account._servedByUrl = normalizedFallbackUrl;

    if (cachingEnabled) {
      cache.set(cacheKey, fallbackResult.account, cacheTtlMs);
      const cacheStatsAfter = redactCacheStats(cache.getStats());
      logger.debug('Horizon cache populate after fallback success', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        cacheKey,
        cacheTtlMs,
        cacheSizeAfter: cacheStatsAfter.size,
        cacheEntryCountAfter: cacheStatsAfter.entries.length,
        source: 'fallback',
        ...safeAccountSummary(fallbackResult.account),
      }));
    }

    logger.debug('Horizon RPC fallback succeeded', safeHorizonContext({
      component: 'horizon',
      stellarAddress,
      horizonUrl,
      horizonUrlFallback: normalizedFallbackUrl,
      fallbackAttempts: fallbackResult.attempts,
      fallbackLatencyMs: fallbackResult.latencyMs,
      servedByUrl: normalizedFallbackUrl,
    }));

    return fallbackResult.account;
  } catch (fallbackError) {
    if (fallbackError instanceof HorizonError) {
      logger.debug('Horizon RPC fallback exhausted', safeHorizonContext({
        component: 'horizon',
        stellarAddress,
        horizonUrl,
        horizonUrlFallback: normalizedFallbackUrl,
        primaryStatusCode: primaryError?.statusCode,
        primaryErrorMessage: primaryError ? redactString(primaryError.message) : undefined,
        fallbackStatusCode: fallbackError.statusCode,
        fallbackErrorMessage: redactString(fallbackError.message),
      }));
    }
    throw fallbackError;
  }
}

export interface WaitForFundedAccountOptions {
  /** Total time budget to keep polling before giving up, in milliseconds. */
  timeoutMs?: number;
  /** Delay between polling attempts, in milliseconds. */
  pollIntervalMs?: number;
  /** Per-request timeout passed through to each `fetchAccount` call. */
  requestTimeoutMs?: number;
  /** Per-request retry count passed through to each `fetchAccount` call. */
  maxRetries?: number;
  /** Called after each unfunded (404) poll, before sleeping for the next attempt. */
  onPoll?: (attempt: number, elapsedMs: number) => void;
  /** Optional AbortSignal from a parent controller (e.g. job cancellation).
   *  When the signal fires, polling stops immediately without emitting a
   *  misleading "account not funded" result. */
  signal?: AbortSignal;
}

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Poll Horizon for an account until it becomes funded or the timeout budget
 * is exhausted. Only Horizon 404 ("not found") responses are treated as
 * "not yet funded" and trigger another poll — any other error (rate limit
 * exhaustion, Horizon outage, network failure) is rethrown immediately so
 * outages don't turn into a silent multi-minute hang.
 */
export async function waitForFundedAccount(
  horizonUrl: string,
  stellarAddress: string,
  options: WaitForFundedAccountOptions = {},
  fetchAccountFn: typeof fetchAccount = fetchAccount,
): Promise<HorizonAccount> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const signal = options.signal;
  const start = Date.now();
  let attempt = 0;

  for (;;) {
    // Bail out cleanly if the job was cancelled — no misleading error message.
    if (signal?.aborted) {
      throw new HorizonError('Polling aborted (job cancelled).', 0, false);
    }

    attempt += 1;

    try {
      return await fetchAccountFn(horizonUrl, stellarAddress, {
        timeoutMs: options.requestTimeoutMs,
        maxRetries: options.maxRetries,
        signal,
      });
    } catch (error) {
      if (!(error instanceof HorizonError) || error.statusCode !== 404) {
        throw error;
      }

      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        throw new HorizonError(
          `Account ${stellarAddress} was still not funded after waiting ${timeoutMs}ms (wait_until_funded timeout).`,
          404,
          false,
        );
      }

      options.onPoll?.(attempt, elapsedMs);

      // Sleep for the poll interval, but abort immediately if the job is cancelled.
      const sleepMs = Math.min(pollIntervalMs, timeoutMs - elapsedMs);
      await cancellableSleep(sleepMs, signal);
    }
  }
}

/**
 * Narrows to a credit trustline balance (`credit_alphanum4` /
 * `credit_alphanum12`) only. Checks the asset_type allowlist explicitly
 * rather than `!== 'native'` — liquidity-pool-share balances
 * (`asset_type: "liquidity_pool_shares"`) carry no `asset_code`/
 * `asset_issuer` and must never be misclassified as a credit trustline,
 * since that would let a same-shaped LP entry slip through a naive
 * trustline match.
 */
export function isCreditBalance(balance: HorizonBalance): balance is HorizonBalanceCredit {
  return balance.asset_type === 'credit_alphanum4' || balance.asset_type === 'credit_alphanum12';
}

export function getNativeBalance(account: HorizonAccount): string {
  const native = account.balances.find((b) => b.asset_type === 'native');
  return native?.balance ?? '0';
}

export function hasTrustline(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): boolean {
  return account.balances.some(
    (balance) =>
      isCreditBalance(balance) &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer,
  );
}

/**
 * Get the trustline limit for a specific asset, if it exists.
 * Returns the limit as a string (as provided by Horizon) or '0' if not found.
 */
export function getTrustlineLimit(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): string {
  const balance = account.balances.find(
    (b) =>
      isCreditBalance(b) &&
      b.asset_code === assetCode &&
      b.asset_issuer === assetIssuer,
  );
  return balance && isCreditBalance(balance) && balance.limit ? balance.limit : '0';
}

export function parseHorizonBalance(balance: string): number {
  const parsed = Number(balance);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface HorizonFetchOptions {
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Auto wallet labels  (Wave #31)
// ---------------------------------------------------------------------------

/**
 * Labels automatically applied to a GitHub issue based on the Stellar
 * wallet state discovered during an account check.
 *
 * - `wallet: funded`           — account exists and XLM balance ≥ reserve.
 * - `wallet: unfunded`         — Horizon returned 404 (account not yet created).
 * - `wallet: trustline-missing`— account funded but missing the required trustline.
 * - `wallet: reserve-low`      — account funded + trustline present but XLM reserve not met.
 * - `wallet: horizon-error`    — Horizon returned a non-404 error; state unknown.
 */
export type WalletLabel =
  | 'wallet: funded'
  | 'wallet: unfunded'
  | 'wallet: trustline-missing'
  | 'wallet: reserve-low'
  | 'wallet: horizon-error';

/**
 * All wallet label strings — useful for bulk removal before re-applying
 * the current state so stale labels never linger on an issue.
 */
export const ALL_WALLET_LABELS: WalletLabel[] = [
  'wallet: funded',
  'wallet: unfunded',
  'wallet: trustline-missing',
  'wallet: reserve-low',
  'wallet: horizon-error',
];

export interface WalletLabelInput {
  /** Whether Horizon returned an active account (HTTP 200). */
  accountFunded: boolean;
  /** Whether the required asset trustline exists on the account. */
  trustlineExists: boolean;
  /** Whether the native XLM balance meets the configured minimum. */
  xlmReserveMet: boolean;
  /** Whether a Horizon error (non-404) occurred during the check. */
  horizonError?: boolean;
}

/**
 * Derive the single wallet label that best describes the current account
 * state. Priority order:
 *
 * 1. `wallet: horizon-error`    — any Horizon error takes precedence.
 * 2. `wallet: unfunded`         — account not found (404).
 * 3. `wallet: trustline-missing`— funded but trustline absent.
 * 4. `wallet: reserve-low`      — funded + trustline but XLM below reserve.
 * 5. `wallet: funded`           — all checks passed.
 */
export function deriveWalletLabel(input: WalletLabelInput): WalletLabel {
  if (input.horizonError) return 'wallet: horizon-error';
  if (!input.accountFunded) return 'wallet: unfunded';
  if (!input.trustlineExists) return 'wallet: trustline-missing';
  if (!input.xlmReserveMet) return 'wallet: reserve-low';
  return 'wallet: funded';
}

/**
 * Options for `applyWalletLabels`.
 */
export interface ApplyWalletLabelsOptions {
  /**
   * Remove all other wallet labels before applying the new one.
   * Default: `true`. Set to `false` to only add (never remove) labels.
   */
  removeStale?: boolean;
}

/**
 * Apply the appropriate wallet label to a GitHub issue via Octokit,
 * optionally removing stale wallet labels first.
 *
 * Errors are non-fatal: label failures are caught and returned as a
 * descriptive string so the main check result is never blocked by a
 * labelling permission issue.
 *
 * @param octokit       Authenticated Octokit instance.
 * @param owner         Repository owner.
 * @param repo          Repository name.
 * @param issueNumber   Issue to label.
 * @param input         Wallet state derived from the Horizon check.
 * @param options       Labelling behaviour options.
 * @returns             The label that was applied, or an error string.
 */
export async function applyWalletLabels(
  octokit: {
    rest: {
      issues: {
        addLabels: (params: { owner: string; repo: string; issue_number: number; labels: string[] }) => Promise<unknown>;
        removeLabel: (params: { owner: string; repo: string; issue_number: number; name: string }) => Promise<unknown>;
        listLabelsOnIssue: (params: { owner: string; repo: string; issue_number: number; per_page: number }) => Promise<{ data: Array<{ name: string }> }>;
      };
    };
  },
  owner: string,
  repo: string,
  issueNumber: number,
  input: WalletLabelInput,
  options: ApplyWalletLabelsOptions = {},
): Promise<{ applied: WalletLabel; removed: string[]; error?: string }> {
  const removeStale = options.removeStale ?? true;
  const targetLabel = deriveWalletLabel(input);
  const removed: string[] = [];

  try {
    if (removeStale) {
      // Fetch current labels to avoid 404s on removeLabel for non-present labels.
      const currentLabelsResponse = await octokit.rest.issues.listLabelsOnIssue({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      const currentNames = currentLabelsResponse.data.map((l) => l.name);

      const stale = ALL_WALLET_LABELS.filter(
        (l) => l !== targetLabel && currentNames.includes(l),
      );

      for (const label of stale) {
        try {
          await octokit.rest.issues.removeLabel({
            owner,
            repo,
            issue_number: issueNumber,
            name: label,
          });
          removed.push(label);
        } catch {
          // Ignore individual remove failures — the add still proceeds.
        }
      }
    }

    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [targetLabel],
    });

    return { applied: targetLabel, removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: targetLabel, removed, error: message };
  }
}
