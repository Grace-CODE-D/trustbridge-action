/**
 * Extended input validation utilities for TrustBridge Action.
 * Provides reusable validators with detailed error messages.
 *
 * ## OpenTelemetry-style spans
 *
 * Every public validator records a lightweight, structured span via
 * `recordSpan()`. Spans are purely in-process and carry:
 *   - `name`       – validator identity (e.g. "validateContractAddress")
 *   - `attributes` – key/value pairs relevant to the call (no PII values)
 *   - `status`     – "ok" | "error"
 *   - `durationMs` – wall-clock time of the validation logic
 *   - `error`      – error message if status is "error"
 *
 * Spans are exported through `getSpans()` / `clearSpans()`. In a GitHub
 * Actions context they are surfaced as debug log lines when `debug_mode`
 * is enabled. In tests they can be inspected directly to assert
 * observability behaviour without mocking `core.debug`.
 *
 * This is an intentionally thin, zero-dependency implementation that
 * mirrors the OpenTelemetry Traces data model (SpanStatus, Attributes)
 * without pulling in the full OTEL SDK, keeping the action bundle small.
 * A real OTEL exporter can be plugged in by replacing `recordSpan()`.
 */

// ---------------------------------------------------------------------------
// Span types and in-process span store
// ---------------------------------------------------------------------------

/** Mirror of the OTel SpanStatus codes relevant to validation. */
export type SpanStatus = 'ok' | 'error';

/** Lightweight span record — mirrors the OTel Span data model. */
export interface ValidationSpan {
  /** Validator function name (e.g. "validateContractAddress"). */
  name: string;
  /** Structured attributes attached to the span. Never contains raw PII values. */
  attributes: Record<string, string | number | boolean>;
  /** Outcome of the validation. */
  status: SpanStatus;
  /** Wall-clock duration of the validation in milliseconds. */
  durationMs: number;
  /** Unix timestamp (ms) when the span started. */
  startTimeMs: number;
  /** Error message when status is "error", undefined otherwise. */
  error?: string;
}

const _spans: ValidationSpan[] = [];

/**
 * Return all recorded validation spans (for testing or debug export).
 * Returns a shallow copy so callers cannot mutate the internal store.
 */
export function getSpans(): ValidationSpan[] {
  return [..._spans];
}

/**
 * Clear all recorded spans (call in test `afterEach` or on action start).
 */
export function clearSpans(): void {
  _spans.length = 0;
}

/**
 * Record a completed span into the in-process store.
 * Safe to call from every validator; never throws.
 */
function recordSpan(span: ValidationSpan): void {
  try {
    _spans.push(span);
  } catch {
    // Swallow — observability must not break validation.
  }
}

/**
 * Internal helper that wraps a synchronous validation callback with span
 * instrumentation. Captures start time, duration, and status automatically.
 *
 * @param name       Span name (validator function name).
 * @param attributes Attributes to attach (no raw user-supplied values).
 * @param fn         The validation logic to run.
 * @returns          The `ValidationResult` produced by `fn`.
 */
function withSpan(
  name: string,
  attributes: ValidationSpan['attributes'],
  fn: () => ValidationResult,
): ValidationResult {
  const startTimeMs = Date.now();
  try {
    const result = fn();
    const durationMs = Date.now() - startTimeMs;
    recordSpan({
      name,
      attributes: { ...attributes, valid: result.valid, errorCount: result.errors.length },
      status: result.valid ? 'ok' : 'error',
      durationMs,
      startTimeMs,
      error: result.errors.length > 0 ? result.errors[0] : undefined,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startTimeMs;
    const message = err instanceof Error ? err.message : String(err);
    recordSpan({
      name,
      attributes: { ...attributes, thrown: true },
      status: 'error',
      durationMs,
      startTimeMs,
      error: message,
    });
    throw err;
  }
}



// ---------------------------------------------------------------------------
// ValidationResult (shared by all validators)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validators (each instrumented with an OTel-style span)
// ---------------------------------------------------------------------------

/**
 * Validates a numeric input string with min/max bounds.
 */
export function validateNumericInput(
  value: string,
  fieldName: string,
  options: {
    min?: number;
    max?: number;
    allowNegative?: boolean;
  } = {},
): ValidationResult {
  return withSpan(
    'validateNumericInput',
    { fieldName, hasMin: options.min !== undefined, hasMax: options.max !== undefined },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const parsed = Number(value);
      if (Number.isNaN(parsed)) {
        errors.push(`${fieldName} must be a valid number, got: "${value}"`);
        return { valid: false, errors, warnings };
      }

      if (!options.allowNegative && parsed < 0) {
        errors.push(`${fieldName} cannot be negative, got: ${parsed}`);
      }

      if (options.min !== undefined && parsed < options.min) {
        errors.push(`${fieldName} must be >= ${options.min}, got: ${parsed}`);
      }

      if (options.max !== undefined && parsed > options.max) {
        errors.push(`${fieldName} must be <= ${options.max}, got: ${parsed}`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/** Soroban contract address ("C-address") StrKey format: "C" + 55 base32 chars. */
const CONTRACT_ADDRESS_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Validates a Soroban contract address ("C-address") against the
 * StrKey structural policy: must be exactly 56 characters, start with
 * "C", and use only the Stellar base32 alphabet (A-Z, 2-7).
 *
 * Records an OTel-style span for every call (success and failure).
 */
export function validateContractAddress(address: string): ValidationResult {
  return withSpan(
    'validateContractAddress',
    // Redact the raw address — only record structural metadata in the span.
    { inputLength: address.trim().length, startsWithC: address.trim().startsWith('C') },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const trimmed = address.trim();

      if (!trimmed) {
        errors.push('Contract address cannot be empty');
        return { valid: false, errors, warnings };
      }

      if (!trimmed.startsWith('C')) {
        errors.push(`Contract address must start with "C", got: "${trimmed}"`);
      }

      if (trimmed.length !== 56) {
        errors.push(`Contract address must be 56 characters, got: ${trimmed.length}`);
      }

      if (!CONTRACT_ADDRESS_REGEX.test(trimmed)) {
        errors.push(
          `Contract address must match StrKey format "C" + 55 base32 characters (A-Z, 2-7), got: "${trimmed}"`,
        );
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/**
 * Validates an asset code (e.g., "USDC", "ETH", "BTC").
 *
 * Records an OTel-style span for every call.
 */
export function validateAssetCode(code: string): ValidationResult {
  return withSpan(
    'validateAssetCode',
    { inputLength: code.trim().length },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const trimmed = code.trim();

      if (!trimmed) {
        errors.push('Asset code cannot be empty');
        return { valid: false, errors, warnings };
      }

      if (trimmed.length > 12) {
        errors.push(`Asset code must be <= 12 characters, got: ${trimmed.length}`);
      }

      if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
        errors.push(`Asset code must be alphanumeric, got: "${trimmed}"`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/**
 * Validates a URL format and protocol.
 *
 * Records an OTel-style span. The URL value itself is not placed in span
 * attributes to avoid leaking potentially sensitive endpoint paths; only the
 * protocol and field name are recorded.
 */
export function validateUrl(
  url: string,
  fieldName: string,
  options: { protocols?: string[] } = {},
): ValidationResult {
  return withSpan(
    'validateUrl',
    { fieldName, allowedProtocols: (options.protocols ?? ['http', 'https']).join(',') },
    () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const trimmed = url.trim();
      if (!trimmed) {
        errors.push(`${fieldName} cannot be empty`);
        return { valid: false, errors, warnings };
      }

      try {
        const parsed = new URL(trimmed);
        const allowedProtos = options.protocols || ['http', 'https'];

        if (!allowedProtos.includes(parsed.protocol.replace(':', ''))) {
          errors.push(
            `${fieldName} must use one of these protocols: ${allowedProtos.join(', ')}`,
          );
        }
      } catch {
        errors.push(`${fieldName} is not a valid URL: "${trimmed}"`);
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
      };
    },
  );
}

/**
 * Combines multiple validation results into a single summary.
 */
export function combineResults(...results: ValidationResult[]): ValidationResult {
  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
