/**
 * Metrics collection for monitoring action performance and behavior.
 *
 * Wave #37: OctokitMetrics — instruments GitHub API (Octokit) calls with
 * per-operation latency, HTTP status codes, retry counts, and structured
 * failure codes. Results are exported as a JSON artifact for dashboard
 * jobs and payout automation to consume.
 */

import { validateContractAddress } from './validation';

export interface MetricPoint {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  tags?: Record<string, string>;
}

/**
 * Tag key that flags a metric as carrying a Soroban contract ("C-address").
 * Metrics tagged this way are validated against the contract address
 * policy before being recorded, so a malformed or malicious value never
 * makes it into the JSON metrics artifact (see toJSON()).
 */
export const CONTRACT_ADDRESS_TAG_KEY = 'contractAddress';

// ---------------------------------------------------------------------------
// OctokitOperationResult  (Wave #37)
// ---------------------------------------------------------------------------

/**
 * Outcome categories for an Octokit API call.
 *
 * - `success`      — HTTP 2xx; operation completed normally.
 * - `auth_error`   — HTTP 401/403; token invalid or missing `issues: write`.
 * - `not_found`    — HTTP 404; issue/repo not found or token lacks read access.
 * - `rate_limited` — HTTP 429 or 403 with rate-limit headers.
 * - `server_error` — HTTP 5xx; transient GitHub infrastructure failure.
 * - `network_error`— Fetch / DNS / TLS failure before a response arrived.
 * - `unknown`      — Any other non-2xx code.
 */
export type OctokitOutcome =
  | 'success'
  | 'auth_error'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'unknown';

/**
 * A single recorded Octokit operation — the raw data that feeds both the
 * in-memory metrics store and the JSON artifact.
 */
export interface OctokitOperationRecord {
  /** Logical name of the operation, e.g. `"issues.createComment"`. */
  operation: string;
  /** HTTP status code returned by the GitHub API, or 0 for network errors. */
  statusCode: number;
  /** Wall-clock milliseconds from call start to response (or error). */
  latencyMs: number;
  /** Classified outcome for dashboards and payout automation. */
  outcome: OctokitOutcome;
  /** Number of retries attempted before this result (0 = first attempt succeeded). */
  retries: number;
  /** ISO-8601 timestamp of when the call was initiated. */
  startedAt: string;
  /** Optional human-readable error message on non-success outcomes. */
  errorMessage?: string;
}

/**
 * Classify an HTTP status code into an `OctokitOutcome`.
 */
export function classifyOctokitStatus(
  statusCode: number,
  headers?: Record<string, string | undefined>,
): OctokitOutcome {
  if (statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode === 401) return 'auth_error';
  if (statusCode === 403) {
    // Rate-limit exceeded returns 403 with x-ratelimit-remaining: 0
    const remaining = headers?.['x-ratelimit-remaining'];
    if (remaining === '0') return 'rate_limited';
    return 'auth_error';
  }
  if (statusCode === 404) return 'not_found';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 500) return 'server_error';
  if (statusCode === 0) return 'network_error';
  return 'unknown';
}

/**
 * Summary exported in the JSON artifact and available to downstream jobs.
 */
export interface OctokitMetricsSummary {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  totalRetries: number;
  outcomeBreakdown: Record<OctokitOutcome, number>;
  operations: OctokitOperationRecord[];
}

/**
 * Instruments GitHub API (Octokit) calls for Wave #37.
 *
 * Usage:
 * ```ts
 * const octokitMetrics = new OctokitMetrics();
 * const result = await octokitMetrics.track('issues.createComment', () =>
 *   octokit.rest.issues.createComment({ ... })
 * );
 * ```
 *
 * After the run, `toJSON()` returns a structured artifact ready for upload
 * with `actions/upload-artifact` or inline debug output.
 */
export class OctokitMetrics {
  private records: OctokitOperationRecord[] = [];

  /**
   * Wrap an Octokit call with latency and outcome tracking.
   *
   * @param operation  Logical name, e.g. `"issues.createComment"`.
   * @param fn         The async Octokit call to execute.
   * @param retries    Number of retries already attempted before this call.
   *                   Pass the retry count from your retry loop; defaults to 0.
   */
  async track<T extends { status: number; headers?: Record<string, string> }>(
    operation: string,
    fn: () => Promise<T>,
    retries: number = 0,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    let statusCode = 0;
    let outcome: OctokitOutcome = 'network_error';
    let errorMessage: string | undefined;

    try {
      const response = await fn();
      statusCode = response.status;
      outcome = classifyOctokitStatus(statusCode, response.headers as Record<string, string | undefined>);
      return response;
    } catch (err) {
      // Octokit throws `RequestError` for non-2xx responses; extract status.
      const requestError = err as { status?: number; message?: string; response?: { headers?: Record<string, string> } };
      if (typeof requestError.status === 'number') {
        statusCode = requestError.status;
        outcome = classifyOctokitStatus(
          statusCode,
          requestError.response?.headers as Record<string, string | undefined> | undefined,
        );
      } else {
        statusCode = 0;
        outcome = 'network_error';
      }
      errorMessage = requestError.message ?? String(err);
      throw err;
    } finally {
      const latencyMs = Date.now() - startMs;
      this.records.push({
        operation,
        statusCode,
        latencyMs,
        outcome,
        retries,
        startedAt,
        errorMessage,
      });
    }
  }

  /**
   * Record a pre-resolved outcome directly (e.g. from a catch block where
   * the Octokit call already resolved but the caller handled the error).
   */
  record(record: OctokitOperationRecord): void {
    this.records.push(record);
  }

  /**
   * Build the summary object used for both in-memory inspection and JSON export.
   */
  getSummary(): OctokitMetricsSummary {
    const outcomeBreakdown: Record<OctokitOutcome, number> = {
      success: 0,
      auth_error: 0,
      not_found: 0,
      rate_limited: 0,
      server_error: 0,
      network_error: 0,
      unknown: 0,
    };

    let totalLatencyMs = 0;
    let totalRetries = 0;

    for (const r of this.records) {
      outcomeBreakdown[r.outcome] = (outcomeBreakdown[r.outcome] ?? 0) + 1;
      totalLatencyMs += r.latencyMs;
      totalRetries += r.retries;
    }

    const totalCalls = this.records.length;
    const successCount = outcomeBreakdown.success;
    const failureCount = totalCalls - successCount;

    return {
      totalCalls,
      successCount,
      failureCount,
      totalLatencyMs,
      averageLatencyMs: totalCalls > 0 ? Math.round(totalLatencyMs / totalCalls) : 0,
      totalRetries,
      outcomeBreakdown,
      operations: this.records.map((r) => ({ ...r })),
    };
  }

  /**
   * Export the Octokit metrics as a JSON artifact string.
   * Safe to pass directly to `core.debug()` or write to a file for
   * `actions/upload-artifact`.
   */
  toJSON(): string {
    return JSON.stringify(this.getSummary(), null, 2);
  }

  /**
   * Return how many operations have been recorded.
   */
  get size(): number {
    return this.records.length;
  }

  /**
   * Clear all recorded operations.
   */
  reset(): void {
    this.records = [];
  }
}

// ---------------------------------------------------------------------------
// MetricsCollector (existing — unchanged public API)
// ---------------------------------------------------------------------------

export class MetricsCollector {
  private metrics: MetricPoint[] = [];
  private counters: Map<string, number> = new Map();
  private timers: Map<string, number> = new Map();

  /**
   * Record a numeric metric. If a `contractAddress` tag is present, it is
   * validated against the Soroban C-address policy first; an invalid
   * address throws rather than being silently recorded.
   */
  recordMetric(name: string, value: number, unit: string = '', tags?: Record<string, string>): void {
    const contractAddress = tags?.[CONTRACT_ADDRESS_TAG_KEY];
    if (contractAddress !== undefined) {
      const result = validateContractAddress(contractAddress);
      if (!result.valid) {
        throw new Error(
          `Invalid ${CONTRACT_ADDRESS_TAG_KEY} tag on metric "${name}": ${result.errors.join('; ')}`,
        );
      }
    }

    this.metrics.push({
      name,
      value,
      unit,
      timestamp: Date.now(),
      tags,
    });
  }

  /**
   * Convenience wrapper for recording a metric tagged with a Soroban
   * contract address, enforcing the C-address policy up front.
   */
  recordContractMetric(
    name: string,
    value: number,
    contractAddress: string,
    unit: string = '',
    extraTags?: Record<string, string>,
  ): void {
    this.recordMetric(name, value, unit, {
      ...extraTags,
      [CONTRACT_ADDRESS_TAG_KEY]: contractAddress,
    });
  }

  /**
   * Increment a counter.
   */
  incrementCounter(name: string, amount: number = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + amount);
  }

  /**
   * Get counter value.
   */
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /**
   * Start a timer.
   */
  startTimer(name: string): void {
    this.timers.set(name, Date.now());
  }

  /**
   * Stop a timer and record the elapsed time.
   */
  stopTimer(name: string, unit: string = 'ms'): number | null {
    const startTime = this.timers.get(name);
    if (startTime === undefined) {
      return null;
    }

    const elapsed = Date.now() - startTime;
    this.recordMetric(`${name}_duration`, elapsed, unit);
    this.timers.delete(name);
    return elapsed;
  }

  /**
   * Get a summary of all recorded metrics.
   */
  getSummary(): {
    metrics: MetricPoint[];
    counters: Record<string, number>;
    totalMetrics: number;
  } {
    return {
      metrics: this.metrics,
      counters: Object.fromEntries(this.counters),
      totalMetrics: this.metrics.length,
    };
  }

  /**
   * Export metrics in JSON format.
   */
  toJSON(): string {
    return JSON.stringify(this.getSummary(), null, 2);
  }

  /**
   * Clear all metrics.
   */
  reset(): void {
    this.metrics = [];
    this.counters.clear();
    this.timers.clear();
  }

  /**
   * Get average value for a metric.
   */
  getAverageMetric(name: string): number | null {
    const metricPoints = this.metrics.filter((m) => m.name === name);
    if (metricPoints.length === 0) {
      return null;
    }

    const sum = metricPoints.reduce((acc, m) => acc + m.value, 0);
    return sum / metricPoints.length;
  }
}

export const globalMetrics = new MetricsCollector();

/** Global Octokit metrics instance — wired into `postIssueComment` and label operations. */
export const globalOctokitMetrics = new OctokitMetrics();
