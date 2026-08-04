/**
 * src/preflight.ts
 *
 * #145 — issues:write preflight check
 *
 * Verifies that the supplied GitHub token has sufficient permission to post
 * issue comments **before** any expensive Horizon calls are made.  Failing
 * fast here gives workflow authors a clear, actionable error instead of a
 * generic GitHub 403 that appears only after Horizon work has completed.
 *
 * ## Preflight sequence
 *
 * 1. **Issue context check** — verify `context.payload.issue.number` exists.
 *    Comment posting is only possible in an issue context; `workflow_dispatch`
 *    and other events skip comment posting and therefore skip the preflight.
 * 2. **Permission probe** — call `GET /repos/{owner}/{repo}/issues/{number}/comments`
 *    with `per_page=1`.  A 403/401 response means the token lacks `issues: read`
 *    and certainly cannot write.  This is less aggressive than a dry-run
 *    `createComment` because it is read-only and will not clutter the issue.
 *    A 404 on the issue itself is surfaced separately (closed/deleted issue).
 *
 * ## Failure modes
 *
 * | Situation | Code | `PreflightResult.skip` | Horizon called? |
 * |-----------|------|----------------------|-----------------|
 * | Non-issue event (no issue context) | — | `true` | Yes (outputs still set) |
 * | Token lacks issues:read/write | 403/401 | `false` | No (run fails) |
 * | Issue not found (404) | 404 | `false` | No (run fails) |
 * | Transient error (5xx) | 5xx | `false` | No (run fails fast) |
 * | Permission check passes | 200 | `false` | Yes |
 *
 * ## Design notes
 *
 * - When there is no issue context the preflight returns `{ skip: true }` so
 *   the caller can proceed without posting a comment (same behaviour as today
 *   for `workflow_dispatch`).
 * - `preflight_only` input: when `true`, the action runs the preflight and
 *   exits immediately without calling Horizon.  Useful for diagnosing
 *   permission issues in new repositories without spending API quota.
 */
export interface PreflightResult {
    /**
     * `true` when there is no issue context and comment posting should simply
     * be skipped.  Horizon checks proceed normally; `postIssueComment` will
     * emit its existing "no issue context" warning.
     */
    skip: boolean;
    /** Human-readable summary of the preflight outcome for logging. */
    message: string;
    /** The resolved issue number, populated when `skip` is false. */
    issueNumber?: number;
}
export interface PreflightOptions {
    /**
     * When `true`, verify that the issue context is present *and* that the
     * token has at minimum `issues:read`.  When `false` (non-issue event),
     * return `{ skip: true }` immediately.
     */
    requireIssueContext?: boolean;
}
/**
 * Run the issues:write preflight sequence.
 *
 * @param token   The `github_token` input value (used to build Octokit).
 * @param options Optional flags controlling preflight behaviour.
 * @returns       A `PreflightResult` — inspect `.skip` to decide whether to
 *                skip comment posting, or throw on hard failures.
 *
 * @throws When the token demonstrably lacks the required permission (401/403)
 *         or the issue is not found (404).  Callers should let these propagate
 *         to `core.setFailed`.
 */
export declare function runIssuesPreflight(token: string, options?: PreflightOptions): Promise<PreflightResult>;
/**
 * Thrown by `runIssuesPreflight` when the token is missing permission or the
 * issue context is invalid.  Callers should surface this via `core.setFailed`.
 */
export declare class PreflightError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number);
}
