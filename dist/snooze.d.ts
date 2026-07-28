/**
 * Failure snooze window (Issue #155).
 *
 * Prevents repeated validation failure comments from spamming an issue
 * within a configurable time window. Stores state in TrustBridge's sticky
 * comment to avoid external dependencies while maintaining per-issue snooze
 * isolation.
 *
 * ## Design
 *
 * **State Storage**: The previous check result (pass/fail) and timestamp are
 * encoded in a hidden marker in TrustBridge's sticky comment. When the action
 * runs, we parse the marker to detect snooze status.
 *
 * **Snooze Trigger**: If the current check fails AND the last check failed
 * AND we're still within the snooze window, suppress the comment update.
 * This prevents comment spam when contributors re-run workflows repeatedly
 * while fixing wallet issues.
 *
 * **Status Changes**: If the current check passes OR we're outside the
 * snooze window, post/update the comment normally. This surfaces both
 * fixes and persistent failures (user is reminded after timeout).
 *
 * **Always Update Outputs**: Even when snoozed, outputs are always set so
 * downstream workflow steps (like badge updates) reflect current state.
 *
 * **Force Post**: An optional `force_comment` input bypasses snooze logic
 * so maintainers can force an immediate comment post if needed.
 */
/**
 * Hidden marker format in comment body:
 * <!-- trustbridge-action:snooze:status={pass|fail},timestamp={unix-ms} -->
 */
export declare const SNOOZE_MARKER_PATTERN: RegExp;
export interface SnoozeMarker {
    status: 'pass' | 'fail';
    timestamp: number;
}
export interface SnoozeState {
    /** Whether current run is snoozed (comment should not be posted). */
    isSnoozed: boolean;
    /** Last recorded check status from prior comment. */
    lastStatus?: 'pass' | 'fail';
    /** Timestamp of last check from prior comment (unix ms). */
    lastTimestamp?: number;
    /** Time elapsed since last check (ms). */
    elapsedMs?: number;
}
/**
 * Extract snooze marker from a comment body. Returns undefined if marker
 * not found (backward compatible with older comments).
 */
export declare function parseSnoozeMarker(commentBody: string | undefined): SnoozeMarker | undefined;
/**
 * Generate a snooze marker string to embed in comment body.
 */
export declare function formatSnoozeMarker(status: 'pass' | 'fail', timestamp?: number): string;
/**
 * Determine snooze state based on current result, last marker, and snooze duration.
 *
 * ### Decision Logic
 *
 * - If current result **passes**: always post (unsnooze on success).
 * - If current result **fails** AND no prior marker: always post (first failure).
 * - If current result **fails** AND prior status **passed**: always post (status changed).
 * - If current result **fails** AND prior status **failed** AND elapsed < snoozeMs:
 *   - **Snoozed** (suppress comment, but still update outputs).
 * - If current result **fails** AND prior status **failed** AND elapsed >= snoozeMs:
 *   - **Post** (reminder after timeout; reset timer).
 */
export declare function evaluateSnoozeState(currentPassed: boolean, lastMarker: SnoozeMarker | undefined, snoozeWindowMs: number): SnoozeState;
