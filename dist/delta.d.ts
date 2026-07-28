/**
 * Delta vs previous workflow-run validation artifact (Security / Issue #148).
 *
 * Consumers retain `validation.json` across runs (upload-artifact + download
 * on the next cron/dispatch). This module compares the prior snapshot to the
 * current check results and produces a structured delta for comments and JSON.
 *
 * Strategy tradeoffs (documented also in docs/USAGE.md):
 * - **Local artifact path (recommended):** workflow downloads the previous
 *   run's artifact to `previous_validation_path`. No extra API scopes; explicit
 *   matching; fails soft when the file is absent (first run).
 * - **GitHub Actions API from inside the action:** would auto-discover the
 *   prior run's artifact, but needs `actions: read`, is brittle around
 *   artifact names / retention / matrix jobs, and couples the action to
 *   Actions API rate limits. Not implemented here.
 */
import { CheckResultItem, ValidationGate, ValidationResult } from './checks';
/** Minimal prior-check shape used for comparison (label + pass/fail). */
export interface CheckSnapshot {
    label: string;
    passed: boolean;
}
/**
 * Machine-readable validation artifact schema written to `validation.json`.
 * Compatible with the Security artifact introduced for auditing (#83).
 * Never includes tokens or auth headers.
 */
export interface ValidationArtifact {
    schemaVersion: string;
    timestamp: string;
    address: string;
    asset: {
        code: string;
        issuer: string;
    };
    horizonUrl?: string;
    readiness: ValidationGate;
    checks: CheckResultItem[];
    balances: {
        xlm: string;
    };
    /** Present when a previous artifact was loaded and compared. */
    delta?: ValidationDelta;
    /** True when addresses/issuers were privacy-redacted in this payload. */
    privacyMode?: boolean;
}
export interface ValidationDelta {
    previousTimestamp?: string;
    newlyPassed: string[];
    newlyFailed: string[];
    unchanged: string[];
    improved: boolean;
    regressed: boolean;
}
export declare const VALIDATION_ARTIFACT_SCHEMA_VERSION = "1.0.0";
/**
 * Hash a Stellar address for privacy-mode JSON artifacts.
 * Returns `sha256:<16 hex chars>` so payloads stay correlatable without
 * exposing the raw G-/C-address in retained artifacts or Actions logs.
 */
export declare function hashAddressForPrivacy(address: string): string;
/**
 * Apply privacy policy to a string that may contain addresses.
 * When privacyMode is on, addresses are hashed; otherwise first4…last4 redaction.
 */
export declare function privacyMaskAddress(address: string, privacyMode: boolean): string;
/**
 * Strip forbidden sensitive keys from an arbitrary object tree (defense in depth
 * when loading a previous artifact that might have been hand-edited).
 */
export declare function stripSensitiveFields<T>(value: T): T;
/**
 * Compare previous vs current checks by label.
 * Returns `null` when there is no previous snapshot (first run) — callers
 * should omit the delta section entirely rather than erroring.
 */
export declare function computeValidationDelta(previous: {
    checks: CheckSnapshot[];
    timestamp?: string;
} | null | undefined, current: {
    checks: CheckSnapshot[];
}): ValidationDelta | null;
/**
 * Load a previous `validation.json` from disk. Returns `null` (no throw) when
 * the path is empty, the file is missing, or JSON is unreadable/invalid —
 * first-run and artifact-miss cases must never fail the action.
 */
export declare function loadPreviousValidationArtifact(previousPath: string, workspaceRoot?: string): ValidationArtifact | null;
export interface BuildValidationArtifactOptions {
    result: ValidationResult;
    stellarAddress: string;
    assetCode: string;
    assetIssuer: string;
    horizonUrl?: string;
    delta?: ValidationDelta | null;
    privacyMode?: boolean;
    timestamp?: string;
}
/**
 * Build the validation.json payload. Applies privacy masking to addresses
 * and strips any accidental sensitive fields. Never embeds tokens.
 */
export declare function buildValidationArtifact(options: BuildValidationArtifactOptions): ValidationArtifact;
/**
 * Render a Markdown delta section for the issue comment.
 * Returns an empty string when there is no delta (first run).
 */
export declare function formatDeltaMarkdown(delta: ValidationDelta | null | undefined): string;
