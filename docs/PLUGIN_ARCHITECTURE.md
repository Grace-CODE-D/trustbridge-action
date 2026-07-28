# TrustBridge Plugin Architecture

Design document for the extensible check system introduced in v1.1.

Related docs: [README](../README.md) · [Usage](USAGE.md) · [Architecture](ARCHITECTURE.md) · [Contributing](../CONTRIBUTING.md)

---

## Why plugins?

The original `runAccountChecks` in `src/checks.ts` hard-codes three checks in a single function. Adding a new check (KYC hook, custom asset rule, governance threshold) requires editing the monolith, risks merge conflicts as contributor count grows, and couples unrelated logic together.

The plugin system solves this by making each check a self-contained, independently testable unit that composes into the same `ValidationResult` structure the rest of the action already understands.

---

## Core concepts

### `CheckPlugin` interface

```ts
interface CheckPlugin {
  /** Stable unique id, e.g. 'my-org/kyc-check' */
  readonly id: string;

  /** Short label shown in the comment results table (~40 chars max) */
  readonly label: string;

  /** Execute the check. Must be synchronous in v1. */
  run(ctx: CheckPluginContext): CheckPluginResult;
}
```

### `CheckPluginContext`

Read-only snapshot of everything a plugin needs. Passed by the runner at call time — plugins never construct their own context.

```ts
interface CheckPluginContext {
  /** Horizon account response, or null when the account is unfunded. */
  readonly account: HorizonAccount | null;

  /** Resolved action inputs (asset code, issuer, reserve, horizon URL). */
  readonly config: Readonly<CheckConfig>;

  /** The Stellar G-address being validated. */
  readonly stellarAddress: string;
}
```

### `CheckPluginResult`

```ts
interface CheckPluginResult {
  /** Whether this check passed. */
  readonly passed: boolean;

  /**
   * Human-readable Markdown sentence for the comment results row.
   * MUST sanitise any untrusted values before returning
   * (use escapeMarkdownInline / inlineCode from src/markdown.ts).
   */
  readonly detail: string;

  /**
   * Optional Markdown guidance shown in the Remediation section.
   * Omit when passed is true, or when no actionable guidance exists.
   */
  readonly remediation?: string;
}
```

---

## Registration flow

Plugins are registered into a `PluginRegistry` before calling `runPlugins()`.

```
┌──────────────────────────────────┐
│          PluginRegistry          │
│  register(plugin)  ← first-wins  │
│  list() → CheckPlugin[]          │
│  unregister(id)                  │
│  clear()                         │
└──────────────┬───────────────────┘
               │ list()
               ▼
┌──────────────────────────────────┐
│           runPlugins()           │
│  for each plugin:                │
│    plugin.run(ctx) → result      │
│  compose → ValidationResult      │
└──────────────────────────────────┘
```

### Example: adding a custom check

```ts
import { CheckPlugin, CheckPluginContext, CheckPluginResult, PluginRegistry } from './src/plugin';
import { runPlugins } from './src/pluginRunner';
import { corePlugins } from './src/corePlugins';

// 1. Define the plugin
const kycPlugin: CheckPlugin = {
  id: 'my-org/kyc-check',
  label: 'KYC verified',
  run(ctx: CheckPluginContext): CheckPluginResult {
    // ctx.config and ctx.account come from typed action inputs / Horizon API.
    // NEVER read from issue body text or eval any string here.
    const verified = myKycLookup(ctx.stellarAddress); // your synchronous logic
    return {
      passed: verified,
      detail: verified ? 'KYC status verified.' : 'KYC check failed.',
      remediation: verified ? undefined : 'Complete KYC at https://your-platform.example/kyc',
    };
  },
};

// 2. Register core + custom plugins
const registry = new PluginRegistry();
[...corePlugins, kycPlugin].forEach(p => registry.register(p));

// 3. Run
const result = runPlugins(ctx, registry);
// result is a standard ValidationResult — compatible with postIssueComment,
// setValidationOutputs, formatCommentBody, and the validation gate.
```

---

## How the three core checks map to plugins

| Existing check in `runAccountChecks` | Plugin id | Plugin file |
|--------------------------------------|-----------|-------------|
| Account funded (Horizon 200 vs 404) | `trustbridge/account-funded` | `src/corePlugins.ts` |
| Trustline for configured asset | `trustbridge/trustline` | `src/corePlugins.ts` |
| XLM balance ≥ `min_xlm_reserve` | `trustbridge/xlm-reserve` | `src/corePlugins.ts` |

The `runAccountChecks` monolith in `src/checks.ts` is **not removed** in this release. It remains the default path in `src/index.ts`. The plugin implementations in `src/corePlugins.ts` are reference implementations and a forward-compatibility bridge. A future major release may replace `runAccountChecks` entirely with `runPlugins(ctx, defaultCoreRegistry)`.

### Composition rules in `runPlugins()`

| `ValidationResult` field | Derived from |
|--------------------------|--------------|
| `valid` | `true` only when every plugin passes |
| `accountFunded` | plugin whose id ends with `account-funded`, fallback: `ctx.account !== null` |
| `trustlineExists` | plugin whose id ends with `trustline`, fallback: `false` |
| `xlmReserveMet` | plugin whose id ends with `xlm-reserve`, fallback: `false` |
| `xlmBalance` | native balance from `ctx.account`, or `'unknown'` |
| `checks` | one `CheckResultItem` per plugin, insertion order |
| `remediation` | failed plugins' `remediation` strings joined with `'\n\n'` |

---

## Failure and remediation propagation

A plugin signals failure by returning `passed: false`. The runner:

1. Sets the corresponding `CheckResultItem.passed` to `false`.
2. Sets `ValidationResult.valid` to `false`.
3. Collects the plugin's `remediation` string (if any) and appends it to the combined `remediation` field, separated by a blank line.

Plugins that pass but include a `remediation` string have that string **ignored** — remediation is only surfaced for failing checks.

If a plugin throws an unexpected error, the runner catches it, marks the check as failed, embeds the error message in `detail`, and continues running the remaining plugins. This prevents one broken plugin from silently killing the entire action.

---

## Security

> **Plugins must not execute arbitrary code sourced from issue bodies.**

The plugin architecture enforces this through several layers:

### 1. Typed context only
`run()` receives a `CheckPluginContext` whose fields come exclusively from:
- Typed action inputs (`CheckConfig`) — validated by `src/inputs.ts` and `src/validation.ts` before reaching any plugin.
- The Horizon API response (`HorizonAccount`) — a typed struct, not raw text.

There is no mechanism for plugins to receive issue body text, comment content, or other user-controlled strings.

### 2. No dynamic imports or eval
Plugins are TypeScript source files reviewed and merged by maintainers. The runner calls `plugin.run(ctx)` directly — it does not dynamically `import()` plugin paths, evaluate strings, or execute shell commands.

### 3. Output escaping responsibility
Plugin `detail` and `remediation` strings are embedded in GitHub issue comments as Markdown. Any value sourced from external data (Horizon responses, config) **must** be escaped with `escapeMarkdownInline()` or wrapped with `inlineCode()` from `src/markdown.ts` before being included in the returned strings. The three core plugins demonstrate this pattern.

### 4. No runtime npm loading
Loading arbitrary npm packages as plugins at runtime (without a code review) is explicitly out of scope for v1. All plugins ship as TypeScript source in this repository.

---

## Versioning and compatibility

- The `CheckPlugin` interface, `CheckPluginContext`, and `CheckPluginResult` shapes are stable from v1.1.
- Adding optional fields to these interfaces is non-breaking.
- Removing or renaming fields is a **breaking change** and requires a major version bump with a migration note.
- The three well-known id suffixes (`account-funded`, `trustline`, `xlm-reserve`) used by `runPlugins()` for field derivation are part of the public API — renaming them breaks the composition rules.

---

## File map

```
src/
  plugin.ts         — CheckPlugin, CheckPluginContext, CheckPluginResult,
                      PluginRegistry, defaultRegistry
  pluginRunner.ts   — runPlugins(ctx, registry?) → ValidationResult
  corePlugins.ts    — accountFundedPlugin, trustlinePlugin, xlmReservePlugin,
                      corePlugins[]
__tests__/
  plugin.test.ts    — Full test suite: registry, runner, core plugins,
                      error resilience, security contract
docs/
  PLUGIN_ARCHITECTURE.md  — This document
```

---

[← Back to Architecture](ARCHITECTURE.md) · [← Back to README](../README.md)
