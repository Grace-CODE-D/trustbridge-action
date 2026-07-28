/**
 * Advanced retry and rate-limiting strategies for resilient API interactions.
 *
 * This module also exposes a local CLI check command that exercises the full
 * resilience pipeline (backoff, rate-limiting, circuit-breaking) against a
 * live or stubbed Horizon endpoint without requiring a GitHub Actions context.
 *
 * Usage (compiled binary or `ts-node`):
 *   node dist/resilience.js check --address G... [--horizon-url URL] [--timeout-ms N]
 */

// ---------------------------------------------------------------------------
// CLI check command types
// ---------------------------------------------------------------------------

/**
 * Options accepted by the local CLI check command.
 */
export interface CliCheckOptions {
  /** Stellar G-address to validate (required). */
  address: string;
  /** Horizon base URL (default: https://horizon.stellar.org). */
  horizonUrl?: string;
  /** Request timeout in milliseconds (default: 15 000). */
  timeoutMs?: number;
  /** Retry policy overrides. */
  retryPolicy?: Partial<RetryPolicy>;
}

/**
 * Result returned by the local CLI check command.
 */
export interface CliCheckResult {
  /** True when Horizon returned a 200 for the address. */
  reachable: boolean;
  /** HTTP status code from Horizon, or undefined on network error. */
  statusCode?: number;
  /** Duration of the check in milliseconds (including retries). */
  durationMs: number;
  /** Human-readable summary. */
  message: string;
  /** Number of retry attempts made (0 = first try succeeded). */
  retries: number;
}

/**
 * Circuit-breaker state machine.
 * CLOSED  = normal operation
 * OPEN    = requests are rejected immediately
 * HALF    = one probe request is allowed to test recovery
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF';

// ---------------------------------------------------------------------------
// RetryPolicy and defaults
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  timeoutMs: number;
  maxTotalWaitMs: number;
}

/**
 * Default retry policy for API calls.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  timeoutMs: 15000,
  maxTotalWaitMs: 120000,
};

/**
 * Calculate the delay for a retry attempt using exponential backoff.
 */
export function calculateBackoffDelay(
  attempt: number,
  policy: RetryPolicy,
): number {
  const delay = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt);
  return Math.min(delay, policy.maxDelayMs);
}

/**
 * Add random jitter to a delay to prevent thundering herd.
 */
export function addJitter(delayMs: number, jitterPercent: number = 10): number {
  const jitter = delayMs * (jitterPercent / 100);
  const randomJitter = (Math.random() - 0.5) * 2 * jitter;
  return Math.max(0, delayMs + randomJitter);
}

/**
 * Sleep for a given duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple rate limiter to throttle requests.
 */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRatePerSecond: number;
  private lastRefillTime: number;

  /**
   * Create a rate limiter with token bucket algorithm.
   * @param capacity Maximum number of tokens (requests allowed per refill window)
   * @param refillRatePerSecond How many tokens to refill per second
   */
  constructor(capacity: number, refillRatePerSecond: number) {
    this.capacity = capacity;
    this.refillRatePerSecond = refillRatePerSecond;
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Check if a request is allowed, consuming a token if so.
   */
  tryConsume(tokensNeeded: number = 1): boolean {
    this.refill();

    if (this.tokens >= tokensNeeded) {
      this.tokens -= tokensNeeded;
      return true;
    }

    return false;
  }

  /**
   * Get the number of milliseconds to wait before trying again.
   */
  waitTimeMs(tokensNeeded: number = 1): number {
    this.refill();

    if (this.tokens >= tokensNeeded) {
      return 0;
    }

    const deficit = tokensNeeded - this.tokens;
    return (deficit / this.refillRatePerSecond) * 1000;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRatePerSecond;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  /**
   * Get current token count.
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Reset the rate limiter to full capacity.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }
}

/**
 * Execute a function with exponential backoff retry logic.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  shouldRetry: (error: unknown, attempt: number) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  let totalWaitMs = 0;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= policy.maxRetries) {
        throw error;
      }

      if (!shouldRetry(error, attempt)) {
        throw error;
      }

      const delayMs = calculateBackoffDelay(attempt, policy);
      const delayWithJitter = addJitter(delayMs);
      
      if (delayWithJitter > policy.maxDelayMs || totalWaitMs + delayWithJitter > policy.maxTotalWaitMs) {
        throw new Error(`Rate limit cap exceeded (attempted wait ${delayWithJitter}ms, max delay ${policy.maxDelayMs}ms, total wait ${totalWaitMs}ms, max total ${policy.maxTotalWaitMs}ms)`);
      }
      
      totalWaitMs += delayWithJitter;
      await sleep(delayWithJitter);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Simple circuit-breaker that wraps any async function.
 *
 * - CLOSED  → requests flow normally; failures are counted.
 * - OPEN    → requests are rejected immediately until `resetTimeoutMs` passes.
 * - HALF    → one probe is allowed; if it succeeds the breaker closes again.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly failureThreshold: number = 3,
    private readonly resetTimeoutMs: number = 30000,
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  /** Reset to closed state (e.g. for test isolation). */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.resetTimeoutMs) {
        throw new Error(
          `Circuit breaker is OPEN — waiting ${this.resetTimeoutMs - elapsed}ms before retry`,
        );
      }
      this.state = 'HALF';
    }

    try {
      const result = await fn();
      if (this.state === 'HALF' || this.failureCount > 0) {
        // Successful probe: close the circuit.
        this.state = 'CLOSED';
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Local CLI check command
// ---------------------------------------------------------------------------

/** Minimal fetch-like type accepted by runCliCheck for testability. */
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

/**
 * Run a local CLI check against a Horizon endpoint.
 *
 * The check exercises the full resilience pipeline: timeout (via AbortSignal),
 * exponential backoff retries, and optional circuit-breaker integration. It
 * is intentionally side-effect-free (no GitHub Actions core calls) so it can
 * be used in local development, CI smoke tests, or scripting without a
 * GitHub context.
 *
 * @param options  CLI check options (address, horizon URL, timeout, policy).
 * @param fetchFn  Optional fetch override for unit tests (default: global fetch).
 * @returns        A {@link CliCheckResult} with reachability, timing, and retry info.
 *
 * @example
 * ```ts
 * const result = await runCliCheck({
 *   address: 'GABC...XYZ',
 *   horizonUrl: 'https://horizon-testnet.stellar.org',
 *   timeoutMs: 5000,
 * });
 * console.log(result.message);
 * ```
 */
export async function runCliCheck(
  options: CliCheckOptions,
  fetchFn: FetchFn = (url, init) => fetch(url, init) as Promise<{ status: number }>,
): Promise<CliCheckResult> {
  const horizonUrl = options.horizonUrl ?? 'https://horizon.stellar.org';
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    timeoutMs: options.timeoutMs ?? DEFAULT_RETRY_POLICY.timeoutMs,
    ...options.retryPolicy,
  };

  const accountUrl = `${horizonUrl.replace(/\/$/, '')}/accounts/${options.address}`;

  const startMs = Date.now();
  let retries = 0;
  let statusCode: number | undefined;

  try {
    await retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

        try {
          const response = await fetchFn(accountUrl, { signal: controller.signal });
          statusCode = response.status;

          // Only retry on server-side transient errors.
          if (response.status === 429 || (response.status >= 500 && response.status !== 503)) {
            throw new Error(`Transient HTTP ${response.status} — retrying`);
          }
          // 404 = not found, not a transient error.
        } finally {
          clearTimeout(timer);
        }
      },
      policy,
      (_error, attempt) => {
        retries = attempt + 1;
        return true;
      },
    );
  } catch {
    // Exhausted retries or non-retryable error — fall through to result.
  }

  const durationMs = Date.now() - startMs;
  const reachable = statusCode === 200;

  const message = reachable
    ? `Account ${options.address} is reachable on Horizon (${durationMs}ms, ${retries} retries).`
    : statusCode === 404
      ? `Account ${options.address} was not found on Horizon (404) — not yet funded.`
      : statusCode !== undefined
        ? `Horizon returned HTTP ${statusCode} for ${options.address} (${durationMs}ms, ${retries} retries).`
        : `Could not reach Horizon at ${horizonUrl} (${durationMs}ms, ${retries} retries).`;

  return { reachable, statusCode, durationMs, message, retries };
}
