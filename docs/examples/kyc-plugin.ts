/**
 * @file docs/examples/kyc-plugin.ts
 *
 * REFERENCE EXAMPLE — Hardened KYC check plugin for TrustBridge.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE IS A COPY-PASTE STARTING POINT, NOT A PRODUCTION IMPLEMENTATION.
 * Replace `yourKycLookup` with your own KYC provider integration and review
 * every TODO comment before shipping to production.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * SAFETY RULES — read before modifying:
 *
 *  1. NO PII IN LOGS.  Never pass raw names, email addresses, national IDs,
 *     or other personally-identifying information to `core.info()`,
 *     `core.debug()`, or `core.warning()`.  Log only the boolean outcome
 *     and a non-identifying reference token (e.g. a pseudonymous hash).
 *
 *  2. NO SECRETS IN DETAIL/REMEDIATION.  The `detail` and `remediation`
 *     strings land verbatim in a public GitHub issue comment.  Never
 *     embed API keys, tokens, internal user IDs, or anything private.
 *
 *  3. ESCAPE ALL DYNAMIC VALUES.  Any string that originates outside this
 *     file (provider response, Stellar address, config value) MUST be
 *     passed through `escapeMarkdownInline()` or `inlineCode()` before
 *     inclusion in `detail` or `remediation`.
 *
 *  4. NO EVAL / NO DYNAMIC IMPORT.  Do not evaluate strings from the KYC
 *     response as code.  Do not dynamically `import()` paths derived from
 *     provider data.
 *
 *  5. PLUGIN IS OPTIONAL.  KYC is consumer logic.  The three core checks
 *     (account funded, trustline, XLM reserve) always run via
 *     `runAccountChecks`.  Register this plugin only when your program
 *     requires identity verification before payout.
 */

import * as core from '@actions/core';
import { CheckPlugin, CheckPluginContext, CheckPluginResult } from '../../src/plugin';
import { escapeMarkdownInline, inlineCode } from '../../src/markdown';

// ---------------------------------------------------------------------------
// KYC provider contract
// ---------------------------------------------------------------------------

/**
 * The shape your KYC lookup function must conform to.
 *
 * Implement this against your chosen KYC provider (e.g. a REST endpoint
 * protected by a secret stored in `secrets.KYC_API_KEY`).
 *
 * IMPORTANT: the function receives only the Stellar G-address — never the
 * contributor's name, email, or any other PII sourced from the issue body.
 * Your backend maps the address to an identity; this plugin never sees PII.
 */
export interface KycLookupFn {
  /**
   * @param stellarAddress  The G-address to look up (56-char public key).
   * @param apiKey          Secret token for your KYC provider API.
   *                        Sourced from `secrets.KYC_API_KEY` — never
   *                        hardcoded here.
   * @returns  A `KycStatus` describing the verification outcome.
   */
  (stellarAddress: string, apiKey: string): KycStatus;
}

/**
 * Outcome returned by the KYC lookup function.
 *
 * `status` values:
 *  - `'approved'`  — identity verified, contributor may proceed.
 *  - `'pending'`   — verification in progress.
 *  - `'rejected'`  — verification failed or was declined.
 *  - `'not_found'` — no KYC record found for this address.
 *
 * `referenceToken` is a pseudonymous, non-PII identifier (e.g. a UUID or
 * hash) your backend assigns to the verification case.  It is safe to
 * include in comments as a support reference without exposing PII.
 */
export interface KycStatus {
  status: 'approved' | 'pending' | 'rejected' | 'not_found';
  /** Pseudonymous case reference — safe to display publicly. */
  referenceToken?: string;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Options for `createKycPlugin`.
 */
export interface KycPluginOptions {
  /**
   * Your KYC lookup implementation.
   * Injected so the plugin is unit-testable without live API calls.
   */
  lookupFn: KycLookupFn;

  /**
   * Secret API key for the KYC provider.
   * Source this from `core.getInput('kyc_api_key')` or
   * `process.env['KYC_API_KEY']` — never hardcode here.
   *
   * The key is passed to `lookupFn` but NEVER logged or embedded in
   * comment output.
   */
  apiKey: string;

  /**
   * URL contributors visit to start or resume KYC.
   * MUST be a fixed, known URL — never constructed from untrusted input.
   *
   * Default: `'https://your-platform.example/kyc'`
   */
  kycUrl?: string;
}

/**
 * Create a hardened KYC check plugin.
 *
 * The factory pattern lets you inject `lookupFn` in tests so no live
 * network call is required.
 *
 * @example
 * ```ts
 * import * as core from '@actions/core';
 * import { createKycPlugin } from './docs/examples/kyc-plugin';
 * import { PluginRegistry } from './src/plugin';
 * import { corePlugins } from './src/corePlugins';
 * import { runPlugins } from './src/pluginRunner';
 *
 * const kycPlugin = createKycPlugin({
 *   lookupFn: myRealKycProvider,
 *   apiKey: core.getInput('kyc_api_key'),   // from secrets.*
 *   kycUrl: 'https://kyc.my-program.example',
 * });
 *
 * const registry = new PluginRegistry();
 * [...corePlugins, kycPlugin].forEach(p => registry.register(p));
 * const result = runPlugins(ctx, registry);
 * ```
 */
export function createKycPlugin(options: KycPluginOptions): CheckPlugin {
  const kycUrl = options.kycUrl ?? 'https://your-platform.example/kyc';

  return {
    id: 'consumer/kyc-check',
    label: 'KYC verified',

    run(ctx: CheckPluginContext): CheckPluginResult {
      // ── Escape the Stellar address before any comment embedding ──────────
      // ctx.stellarAddress comes from the action's typed input and has
      // already been validated as a 56-char G-address by validateStellarAddress()
      // in src/checks.ts.  We still escape it here as defence-in-depth.
      const safeAddress = inlineCode(ctx.stellarAddress);

      // ── Call the KYC provider ────────────────────────────────────────────
      // Pass only the address and the API key.  The key is NEVER logged.
      let kycStatus: KycStatus;
      try {
        kycStatus = options.lookupFn(ctx.stellarAddress, options.apiKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        // Log at warning level — no PII, no key, just the error category.
        core.warning(`[kyc-plugin] KYC lookup failed for address (redacted): ${message}`);
        return {
          passed: false,
          detail: 'KYC check could not be completed due to a provider error.',
          remediation: `Retry later or contact support. Visit ${escapeMarkdownInline(kycUrl)} to check your status.`,
        };
      }

      // ── Build the safe reference token string ────────────────────────────
      // referenceToken is a pseudonymous case ID from your backend.
      // It is safe to surface in comments; it does NOT contain PII.
      const safeToken = kycStatus.referenceToken
        ? ` (ref: ${inlineCode(escapeMarkdownInline(kycStatus.referenceToken))})`
        : '';

      // ── Log the outcome without PII ──────────────────────────────────────
      // Log only the boolean status and the non-PII token.
      // NEVER log: contributor name, email, national ID, DOB, or raw address.
      core.info(
        `[kyc-plugin] KYC status=${kycStatus.status}${kycStatus.referenceToken ? ` ref=${kycStatus.referenceToken}` : ''}`,
      );

      // ── Compose the CheckPluginResult ────────────────────────────────────
      switch (kycStatus.status) {
        case 'approved':
          return {
            passed: true,
            detail: `KYC verification approved for ${safeAddress}${safeToken}.`,
          };

        case 'pending':
          return {
            passed: false,
            detail: `KYC verification is in progress for ${safeAddress}${safeToken}.`,
            remediation: `Your KYC review is pending. Check your status at ${escapeMarkdownInline(kycUrl)} and retry once approved.`,
          };

        case 'rejected':
          return {
            passed: false,
            // Do NOT include the rejection reason — it may contain PII from
            // the provider response (e.g. document mismatch details).
            detail: `KYC verification was not approved for ${safeAddress}${safeToken}.`,
            remediation: `Visit ${escapeMarkdownInline(kycUrl)} to review your verification status or appeal.`,
          };

        case 'not_found':
          return {
            passed: false,
            detail: `No KYC record found for ${safeAddress}${safeToken}.`,
            remediation: `Complete KYC at ${escapeMarkdownInline(kycUrl)} before requesting payout.`,
          };
      }
    },
  };
}
