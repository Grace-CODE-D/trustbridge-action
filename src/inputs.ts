export function parseBooleanInput(value: string, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export function parseNumberInput(
  value: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric input, but received: "${value}"`);
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Value must be at least ${options.min}. Received: ${parsed}`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`Value must be at most ${options.max}. Received: ${parsed}`);
  }

  return parsed;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// #147 — TRUSTBRIDGE_* environment variable support
// ---------------------------------------------------------------------------

/**
 * Mapping of TRUSTBRIDGE_* environment variable names to the corresponding
 * action input names.  These env vars act as a lower-precedence layer:
 * an explicit `with:` input always wins; the env var is only consulted when
 * the `with:` value is empty/unset.
 *
 * This is the single source of truth for the env→input mapping.  Update
 * docs/USAGE.md and tests whenever this table changes.
 *
 * Fields NOT included (intentionally):
 *   - `github_token`   — never supply secrets via env vars in workflow logs
 *   - `stellar_address_input` — required input; must be explicit in workflow
 */
export const TRUSTBRIDGE_ENV_MAP: Record<string, string> = {
  TRUSTBRIDGE_HORIZON_URL: 'horizon_url',
  TRUSTBRIDGE_HORIZON_URL_FALLBACK: 'horizon_url_fallback',
  TRUSTBRIDGE_RPC_FALLBACK_URL: 'rpc_fallback_url',
  TRUSTBRIDGE_ASSET_CODE: 'asset_code',
  TRUSTBRIDGE_ASSET_ISSUER: 'asset_issuer',
  TRUSTBRIDGE_MIN_XLM_RESERVE: 'min_xlm_reserve',
  TRUSTBRIDGE_FAIL_ON_MISSING: 'fail_on_missing',
  TRUSTBRIDGE_DEBUG_MODE: 'debug_mode',
  TRUSTBRIDGE_HORIZON_TIMEOUT_MS: 'horizon_timeout_ms',
  TRUSTBRIDGE_STICKY_COMMENT: 'sticky_comment',
  TRUSTBRIDGE_WAIT_UNTIL_FUNDED: 'wait_until_funded',
  TRUSTBRIDGE_WAIT_UNTIL_FUNDED_TIMEOUT_MS: 'wait_until_funded_timeout_ms',
  TRUSTBRIDGE_WAIT_UNTIL_FUNDED_INTERVAL_MS: 'wait_until_funded_interval_ms',
  TRUSTBRIDGE_HORIZON_CACHE_TTL_MS: 'horizon_cache_ttl_ms',
  TRUSTBRIDGE_USE_CACHE: 'use_cache',
  TRUSTBRIDGE_LOG_INPUTS: 'log_inputs',
  TRUSTBRIDGE_PREFLIGHT_ONLY: 'preflight_only',
};

/**
 * Return the value for an action input, falling back to the corresponding
 * `TRUSTBRIDGE_*` environment variable when the `with:` value is empty.
 *
 * Precedence (highest first):
 *   1. Explicit `with:` input value (passed as `withValue`)
 *   2. `TRUSTBRIDGE_*` environment variable
 *   3. Empty string (caller applies its own default)
 *
 * Secret fields (`github_token`) are excluded from the env var lookup and
 * must always be supplied explicitly via `with:`.
 *
 * @param inputName  The action input name (e.g. `"horizon_url"`).
 * @param withValue  The value returned by `core.getInput(inputName)`.
 * @param env        Process environment (injectable for testing, defaults to
 *                   `process.env`).
 */
export function resolveInput(
  inputName: string,
  withValue: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  if (withValue !== '') {
    return withValue;
  }

  // Find the env var key whose mapped value matches this input name
  const envKey = Object.entries(TRUSTBRIDGE_ENV_MAP).find(
    ([, mapped]) => mapped === inputName,
  )?.[0];

  if (envKey) {
    const envValue = env[envKey];
    if (envValue !== undefined && envValue !== '') {
      return envValue;
    }
  }

  return '';
}
