/**
 * @file corePlugins.ts
 * The three built-in TrustBridge checks expressed as CheckPlugins.
 *
 * These serve two purposes:
 *   1. Reference implementations that plugin authors can study to
 *      understand the expected shape of a plugin.
 *   2. Drop-in replacements for the equivalent logic inside
 *      `runAccountChecks` when projects want a fully plugin-driven
 *      pipeline.
 *
 * The existing `runAccountChecks` monolith in `checks.ts` is **not**
 * changed in this PR — these plugins coexist alongside it. A future
 * major release may elect to replace `runAccountChecks` entirely with
 * `runPlugins([...corePlugins])`.
 *
 * SECURITY: All detail strings that embed data from `ctx` use the same
 * `escapeMarkdownInline` / `inlineCode` helpers as `runAccountChecks`
 * so no untrusted value can inject Markdown formatting.
 */

import { CheckPlugin, CheckPluginContext, CheckPluginResult } from './plugin';
import {
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  estimateTrustlineSetupCost,
  buildReserveRequirement,
} from './checks';
import { getNativeBalance, hasTrustline, parseHorizonBalance } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import { buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';

// ---------------------------------------------------------------------------
// 1. Account funded
// ---------------------------------------------------------------------------

/**
 * Checks that the Stellar account exists and is activated on the network.
 *
 * Passes  — `ctx.account` is not null (Horizon returned a 200).
 * Fails   — `ctx.account` is null (Horizon returned 404 / account unfunded).
 *
 * Plugin id: `'trustbridge/account-funded'`
 */
export const accountFundedPlugin: CheckPlugin = {
  id: 'trustbridge/account-funded',
  label: 'Account funded',

  run(ctx: CheckPluginContext): CheckPluginResult {
    if (ctx.account !== null) {
      return {
        passed: true,
        detail: `Account ${inlineCode(ctx.stellarAddress)} is active on the Stellar network.`,
      };
    }

    const safeAddress = inlineCode(ctx.stellarAddress);
    return {
      passed: false,
      detail: `Account ${safeAddress} was **not found** on Horizon — it may not be funded or activated yet.`,
      remediation: [
        `Activate ${safeAddress} by sending at least **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM** (Stellar minimum account balance).`,
        `Estimated setup cost: ~**${estimateTrustlineSetupCost()} XLM** (1 XLM base + 0.5 XLM per trustline reserve).`,
      ].join('\n\n'),
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Trustline
// ---------------------------------------------------------------------------

/**
 * Checks that the account holds a trustline for the configured asset.
 *
 * Passes  — account has a trustline for `config.assetCode` / `config.assetIssuer`.
 * Fails   — trustline is absent or account is not funded.
 *
 * Plugin id: `'trustbridge/trustline'`
 */
export const trustlinePlugin: CheckPlugin = {
  id: 'trustbridge/trustline',
  label: 'Trustline',

  run(ctx: CheckPluginContext): CheckPluginResult {
    const safeAssetCode = escapeMarkdownInline(ctx.config.assetCode);
    const safeIssuer = inlineCode(ctx.config.assetIssuer);
    const network = inferStellarNetwork(ctx.config.horizonUrl ?? '');

    if (ctx.account === null) {
      return {
        passed: false,
        detail: 'Cannot verify trustline until the account exists.',
      };
    }

    const exists = hasTrustline(ctx.account, ctx.config.assetCode, ctx.config.assetIssuer);
    const hasAnyTrustlines = ctx.account.balances.some((b) => b.asset_type !== 'native');

    if (exists) {
      return {
        passed: true,
        detail: `Trustline for **${safeAssetCode}** (${safeIssuer}) is configured.`,
      };
    }

    const detail = hasAnyTrustlines
      ? `Account has trustlines, but not for **${safeAssetCode}** issued by ${safeIssuer}.`
      : 'Account has **zero trustlines** — add a trustline before receiving this asset.';

    return {
      passed: false,
      detail,
      remediation: `Add a **${safeAssetCode}** trustline using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Change Trust operation) or a wallet such as [LOBSTR](${buildLobstrLink()}).`,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. XLM reserve
// ---------------------------------------------------------------------------

/**
 * Checks that the account's native XLM balance meets the configured minimum.
 *
 * Passes  — balance ≥ `config.minXlmReserve`.
 * Fails   — balance is below the minimum, or account is not funded.
 *
 * Plugin id: `'trustbridge/xlm-reserve'`
 */
export const xlmReservePlugin: CheckPlugin = {
  id: 'trustbridge/xlm-reserve',
  label: 'XLM reserve',

  run(ctx: CheckPluginContext): CheckPluginResult {
    if (ctx.account === null) {
      return {
        passed: false,
        detail: `Cannot verify XLM balance. Fund the account with at least **${ctx.config.minXlmReserve} XLM**.`,
      };
    }

    const xlmBalance = getNativeBalance(ctx.account);
    const xlmNumeric = parseHorizonBalance(xlmBalance);
    const reserve = buildReserveRequirement(ctx.config.minXlmReserve, xlmNumeric);

    if (reserve.met) {
      return {
        passed: true,
        detail: `Balance **${inlineCode(xlmBalance)} XLM** meets the minimum of **${ctx.config.minXlmReserve} XLM**.`,
      };
    }

    return {
      passed: false,
      detail: `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${ctx.config.minXlmReserve} XLM**.`,
      remediation: `Send at least **${reserve.missing} XLM** to ${inlineCode(ctx.account.account_id)} to meet the reserve requirement.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Convenience export — all three core plugins in canonical order
// ---------------------------------------------------------------------------

/**
 * The three built-in checks in the order they appear in the comment table.
 * Pass this array to `runPlugins()` to get a fully plugin-driven result
 * equivalent to `runAccountChecks()`.
 *
 * ```ts
 * import { runPlugins } from './pluginRunner';
 * import { corePlugins } from './corePlugins';
 * import { PluginRegistry } from './plugin';
 *
 * const registry = new PluginRegistry();
 * corePlugins.forEach(p => registry.register(p));
 * const result = runPlugins(ctx, registry);
 * ```
 */
export const corePlugins: CheckPlugin[] = [
  accountFundedPlugin,
  trustlinePlugin,
  xlmReservePlugin,
];
