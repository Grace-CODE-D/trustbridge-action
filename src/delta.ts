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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CheckResultItem, ValidationGate, ValidationResult, buildValidationGate } from './checks';
import { redactStellarAddress, redactString } from './logger';

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

export const VALIDATION_ARTIFACT_SCHEMA_VERSION = '1.0.0';

/** Keys that must never appear in a validation / delta payload. */
const FORBIDDEN_SENSITIVE_KEYS = new Set([
  'github_token',
  'githubToken',
  'token',
  'authorization',
  'Authorization',
  'api_key',
  'apiKey',
  'password',
  'secret',
  'private_key',
  'privateKey',
  'passphrase',
]);

/**
 * Hash a Stellar address for privacy-mode JSON artifacts.
 * Returns `sha256:<16 hex chars>` so payloads stay correlatable without
 * exposing the raw G-/C-address in retained artifacts or Actions logs.
 */
export function hashAddressForPrivacy(address: string): string {
  const digest = crypto.createHash('sha256').update(address.trim()).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

/**
 * Apply privacy policy to a string that may contain addresses.
 * When privacyMode is on, addresses are hashed; otherwise first4…last4 redaction.
 */
export function privacyMaskAddress(address: string, privacyMode: boolean): string {
  if (!address) return address;
  if (privacyMode) return hashAddressForPrivacy(address);
  return redactStellarAddress(address);
}

/**
 * Strip forbidden sensitive keys from an arbitrary object tree (defense in depth
 * when loading a previous artifact that might have been hand-edited).
 */
export function stripSensitiveFields<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveFields(item)) as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SENSITIVE_KEYS.has(key)) continue;
      out[key] = stripSensitiveFields(child);
    }
    return out as T;
  }
  return value;
}

/**
 * Compare previous vs current checks by label.
 * Returns `null` when there is no previous snapshot (first run) — callers
 * should omit the delta section entirely rather than erroring.
 */
export function computeValidationDelta(
  previous: { checks: CheckSnapshot[]; timestamp?: string } | null | undefined,
  current: { checks: CheckSnapshot[] },
): ValidationDelta | null {
  if (!previous || !Array.isArray(previous.checks) || previous.checks.length === 0) {
    return null;
  }

  const previousByLabel = new Map<string, boolean>();
  for (const check of previous.checks) {
    if (check && typeof check.label === 'string') {
      previousByLabel.set(check.label, Boolean(check.passed));
    }
  }

  const newlyPassed: string[] = [];
  const newlyFailed: string[] = [];
  const unchanged: string[] = [];

  for (const check of current.checks) {
    const prior = previousByLabel.get(check.label);
    if (prior === undefined) {
      // New check label not present previously — treat as newly passed/failed.
      if (check.passed) newlyPassed.push(check.label);
      else newlyFailed.push(check.label);
      continue;
    }
    if (prior === check.passed) {
      unchanged.push(check.label);
    } else if (check.passed && !prior) {
      newlyPassed.push(check.label);
    } else if (!check.passed && prior) {
      newlyFailed.push(check.label);
    }
  }

  return {
    previousTimestamp: previous.timestamp,
    newlyPassed,
    newlyFailed,
    unchanged,
    improved: newlyPassed.length > 0,
    regressed: newlyFailed.length > 0,
  };
}

/**
 * Load a previous `validation.json` from disk. Returns `null` (no throw) when
 * the path is empty, the file is missing, or JSON is unreadable/invalid —
 * first-run and artifact-miss cases must never fail the action.
 */
export function loadPreviousValidationArtifact(
  previousPath: string,
  workspaceRoot?: string,
): ValidationArtifact | null {
  const trimmed = (previousPath || '').trim();
  if (!trimmed) return null;

  const root = workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd();
  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);

  try {
    if (!fs.existsSync(absolutePath)) {
      return null;
    }
    const raw = fs.readFileSync(absolutePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const cleaned = stripSensitiveFields(parsed) as Partial<ValidationArtifact>;
    if (!Array.isArray(cleaned.checks)) return null;

    return {
      schemaVersion: cleaned.schemaVersion || VALIDATION_ARTIFACT_SCHEMA_VERSION,
      timestamp: typeof cleaned.timestamp === 'string' ? cleaned.timestamp : '',
      address: typeof cleaned.address === 'string' ? cleaned.address : '',
      asset: {
        code: cleaned.asset?.code ?? '',
        issuer: cleaned.asset?.issuer ?? '',
      },
      horizonUrl: cleaned.horizonUrl,
      readiness: cleaned.readiness ?? {
        ready: false,
        totalChecks: cleaned.checks.length,
        passedChecks: cleaned.checks.filter((c) => c.passed).length,
        failedChecks: cleaned.checks.filter((c) => !c.passed).length,
        failedLabels: cleaned.checks.filter((c) => !c.passed).map((c) => c.label),
      },
      checks: cleaned.checks.map((c) => ({
        label: c.label,
        passed: Boolean(c.passed),
        detail: typeof c.detail === 'string' ? redactString(c.detail) : '',
      })),
      balances: {
        xlm: cleaned.balances?.xlm ?? 'unknown',
      },
      delta: cleaned.delta,
      privacyMode: cleaned.privacyMode,
    };
  } catch {
    return null;
  }
}

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
export function buildValidationArtifact(options: BuildValidationArtifactOptions): ValidationArtifact {
  const privacyMode = Boolean(options.privacyMode);
  // Full addresses by default (auditing). Privacy mode hashes them for retained artifacts.
  const address = privacyMode
    ? privacyMaskAddress(options.stellarAddress, true)
    : options.stellarAddress;
  const issuer = privacyMode
    ? privacyMaskAddress(options.assetIssuer, true)
    : options.assetIssuer;

  const checks: CheckResultItem[] = options.result.checks.map((c) => ({
    label: c.label,
    passed: c.passed,
    detail: privacyMode
      ? redactString(c.detail).replace(/\b([GC][A-Z2-7]{55})\b/g, (m) => hashAddressForPrivacy(m))
      : c.detail,
  }));

  const artifact: ValidationArtifact = {
    schemaVersion: VALIDATION_ARTIFACT_SCHEMA_VERSION,
    timestamp: options.timestamp ?? new Date().toISOString(),
    address,
    asset: {
      code: options.assetCode,
      issuer,
    },
    horizonUrl: options.horizonUrl
      ? privacyMode
        ? redactString(options.horizonUrl).replace(/\b([GC][A-Z2-7]{55})\b/g, (m) =>
            hashAddressForPrivacy(m),
          )
        : options.horizonUrl
      : undefined,
    readiness: buildValidationGate(options.result),
    checks,
    balances: {
      xlm: options.result.xlmBalance,
    },
    privacyMode: privacyMode || undefined,
  };

  if (options.delta) {
    artifact.delta = options.delta;
  }

  return stripSensitiveFields(artifact);
}

/**
 * Render a Markdown delta section for the issue comment.
 * Returns an empty string when there is no delta (first run).
 */
export function formatDeltaMarkdown(delta: ValidationDelta | null | undefined): string {
  if (!delta) return '';

  const lines: string[] = [
    '### Delta vs previous run',
    '',
  ];

  if (delta.previousTimestamp) {
    lines.push(`_Compared to previous artifact from \`${delta.previousTimestamp}\`._`, '');
  }

  if (delta.newlyPassed.length === 0 && delta.newlyFailed.length === 0) {
    lines.push('- No check status changes since the previous run.');
  } else {
    if (delta.newlyPassed.length > 0) {
      lines.push(`- ✅ **Newly passed:** ${delta.newlyPassed.join(', ')}`);
    }
    if (delta.newlyFailed.length > 0) {
      lines.push(`- ❌ **Newly failed:** ${delta.newlyFailed.join(', ')}`);
    }
  }

  if (delta.unchanged.length > 0) {
    lines.push(`- Unchanged: ${delta.unchanged.length} check(s)`);
  }

  if (delta.regressed) {
    lines.push('', '_Regression detected — one or more checks that previously passed now fail._');
  } else if (delta.improved && !delta.regressed) {
    lines.push('', '_Improvement — checks newly passing with no new failures._');
  }

  return lines.join('\n');
}
