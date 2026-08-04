/**
 * Expert-mode diagnostics block for TrustBridge issue comments (Issue #102).
 *
 * When `debug_mode: true` (or the forthcoming `expert_mode: true`) is set,
 * a clearly-separated diagnostics section is appended to the issue comment
 * after the normal contributor-facing content. The contributor-facing section
 * is never modified or cluttered by this addition.
 *
 * ## What the diagnostics block contains
 * - Horizon status code and round-trip latency
 * - Normalized resolved inputs (redacted — no raw secrets)
 * - Check-level detail rows showing each assertion, its pass/fail state, and
 *   the underlying data value that drove the decision
 * - Error messages from failed Horizon calls (redacted)
 *
 * ## Security guarantees
 * - `github_token`, `webhook_secret`, and any other secret-classified fields
 *   are **never** included. The secret-field block-list mirrors the one in
 *   `src/configReader.ts`.
 * - Stellar addresses are redacted via `redactStellarAddress` (first-4/last-4).
 * - Horizon URLs are redacted via `redactHorizonUrl`.
 * - Free-form error messages are scanned with `redactString` before inclusion.
 */
export interface DiagnosticsInputSnapshot {
    horizonUrl: string;
    horizonUrlFallback?: string;
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: string | number;
    horizonTimeoutMs: number;
    useCache: boolean;
    cacheTtlMs?: number;
    allowCrossNetworkFallback: boolean;
    debugMode: boolean;
    /** Any additional resolved scalar inputs to surface. */
    [key: string]: unknown;
}
export interface DiagnosticsRunInfo {
    /** HTTP status code returned by Horizon (undefined when cached or not reached). */
    horizonStatusCode?: number;
    /** Round-trip latency to Horizon in milliseconds. */
    horizonLatencyMs?: number;
    /** Primary Horizon error message, if any (will be redacted). */
    horizonError?: string;
    /** Whether the result was served from the in-memory cache. */
    fromCache?: boolean;
    /** Whether the fallback URL was used for this request. */
    usedFallback?: boolean;
    /** Number of retry attempts made before a final response. */
    retryCount?: number;
}
export interface DiagnosticsConfig {
    /** Resolved action inputs snapshot. */
    inputs: DiagnosticsInputSnapshot;
    /** Runtime information about the Horizon request. */
    runInfo?: DiagnosticsRunInfo;
    /** Whether to include the full normalized-inputs table (default true). */
    showInputs?: boolean;
}
/**
 * Build a redacted, safe-to-log copy of the inputs snapshot.
 * Secret-classified fields are replaced with `***`.
 * Address and URL fields are redacted using the standard policy.
 */
export declare function buildSafeInputsSnapshot(inputs: DiagnosticsInputSnapshot): Record<string, unknown>;
declare const DIAGNOSTICS_OPEN_MARKER = "<!-- trustbridge-action:diagnostics-start -->";
declare const DIAGNOSTICS_CLOSE_MARKER = "<!-- trustbridge-action:diagnostics-end -->";
/**
 * Build the expert diagnostics collapsible Markdown block.
 *
 * Returns an empty string when neither `inputs` nor `runInfo` has meaningful
 * content, so callers can append unconditionally.
 */
export declare function buildDiagnosticsBlock(config: DiagnosticsConfig): string;
export { DIAGNOSTICS_OPEN_MARKER, DIAGNOSTICS_CLOSE_MARKER };
