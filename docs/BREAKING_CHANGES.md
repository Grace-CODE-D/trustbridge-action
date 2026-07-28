# Breaking Changes & Versioning Policy

This document is the canonical reference for how TrustBridge Action classifies input and output changes, manages deprecation, and governs the `@v` major-tag contract with consumers.

Related docs: [README](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [Release Checklist](RELEASE_CHECKLIST.md)

---

## Versioning contract

TrustBridge Action follows **Semantic Versioning** ([semver.org](https://semver.org)):

| Version segment | Incremented when |
|-----------------|-----------------|
| **MAJOR** (`v2`) | A breaking change is introduced — consumers must update their workflow files |
| **MINOR** (`v1.1`) | New optional inputs, new outputs, or safe behaviour additions |
| **PATCH** (`v1.0.1`) | Bug fixes, documentation corrections, dependency updates with no behaviour change |

### Major tag (`@v`) expectations

Consumers are expected to pin to a major tag (e.g. `@v1`) rather than a full SHA or patch tag. This follows [GitHub's official guidance for Action versioning](https://docs.github.com/en/actions/creating-actions/releasing-and-maintaining-actions).

```yaml
# Recommended — automatically receives minor/patch improvements
uses: Stellar-TrustBridge/trustbridge-action@v1

# Pinned to a specific release — safest for regulated or audit-required workflows
uses: Stellar-TrustBridge/trustbridge-action@v1.2.3
```

**Moving the major tag.** Maintainers move the `@v1` tag to the latest patch on that major line after every release (see [docs/RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)). The `@v1` tag is **never** moved to a new major release — `v2` will receive its own distinct tag.

**Semver bot automation.** Automated major-tag bumping via a release bot is out of scope for the current release process and is documented only as a future consideration.

---

## Classification: breaking vs non-breaking changes

### Breaking (MAJOR bump required)

A change is **breaking** if a consumer workflow that worked correctly on the previous major version would fail, produce wrong outputs, or require a workflow-file edit after the upgrade.

| Change type | Example |
|-------------|---------|
| Remove a required input | Removing `stellar_address_input` or `github_token` |
| Remove an optional input | Removing `fail_on_missing` (consumers who set it explicitly break) |
| Remove an output | Removing `account_funded`, `trustline_exists`, `xlm_balance`, or `comment_url` |
| Rename an input | Renaming `fail_on_missing` → `on_failure` |
| Rename an output | Renaming `account_funded` → `is_funded` |
| Change the **type** or **unit** of an input/output | Changing `xlm_balance` from a decimal string (`"1.5"`) to an integer stroops value |
| Change the **default** of an input in a way that alters behaviour | Changing `fail_on_missing` default from `"true"` to `"false"` |
| Change the **default** of `horizon_url` to a different network | Switching the default from mainnet to testnet |
| Raise the minimum Node.js runtime | Moving `runs.using` from `node20` to a version not available on older GitHub-hosted runners |
| Remove the ability to pass `.trustbridge.yml` config | Removing `trustbridge_config_path` or the config-file feature entirely |
| Tighten validation so previously accepted values are now rejected | Making `min_xlm_reserve` reject `"0"` when it previously accepted it |

### Non-breaking / safe (MINOR or PATCH)

A change is **safe** if consumers who do not adopt it see no change in behaviour, and those who do adopt it gain new capability without breaking existing workflow files.

| Change type | Example |
|-------------|---------|
| Add a new **optional** input with a safe default | Adding `horizon_cache_ttl_ms` with default `"60000"` (existing runs behave identically) |
| Add a new **output** | Adding `comment_url` output — consumers who don't use it are unaffected |
| Widen accepted input values | Accepting `"0"` for `min_xlm_reserve` where it was previously rejected |
| Change a default in a **backwards-compatible** direction | Increasing `horizon_timeout_ms` default from `15000` to `20000` (consumers who pinned it see no change) |
| Improve comment formatting or remediation text | Updating the Markdown layout of the issue comment — `fail_on_missing` behaviour is unchanged |
| Add or relax a non-required validation | Accepting `C…` contract addresses in `asset_issuer` when only `G…` was accepted before |
| Performance improvements | Reducing unnecessary Horizon round-trips via `use_cache` without changing output values |
| Bug fixes that restore documented behaviour | Fixing `wait_until_funded` to honour `wait_until_funded_timeout_ms` correctly |
| Dependency version bumps with no API surface change | Updating `@actions/core` or `@octokit/rest` patch versions |
| Documentation-only changes | Correcting a typo in `README.md` or adding a workflow recipe to `docs/USAGE.md` |

---

## Deprecation process

TrustBridge follows a **warn → remove** lifecycle spanning at least one full major version:

### Step 1 — Warn (in the current major)

When an input or output is scheduled for removal:

1. Annotate `action.yml` with a `# DEPRECATED` comment on the input and update its `description` to state the replacement and the target removal version:
   ```yaml
   use_cache:
     # DEPRECATED — use horizon_cache_ttl_ms instead. Will be removed in v2.
     description: >-
       [DEPRECATED: use horizon_cache_ttl_ms instead. Will be removed in v2.]
       Cache successful Horizon account responses in job memory to minimize redundant calls.
     required: false
     default: 'false'
   ```
2. Emit a `core.warning` at runtime whenever the deprecated input is set to a non-default value:
   ```
   [TrustBridge] WARNING: input "use_cache" is deprecated and will be removed in v2.
   Use "horizon_cache_ttl_ms" instead (set to 0 to disable caching).
   ```
3. Update `README.md` to mark the input with a **⚠️ Deprecated** badge in the inputs table.
4. Add an entry to the [Deprecation history](#deprecation-history) section of this document.

### Step 2 — Remove (in the next major)

When the major version is bumped:

1. Delete the deprecated input/output from `action.yml`.
2. Remove runtime handling from `src/`.
3. Update `README.md` and `docs/USAGE.md` to remove references.
4. Record the removal in the [Change history](#change-history) section below.

### Minimum deprecation window

An input or output **must** remain in the warn state for **at least one full major release** before it can be removed. For example, a deprecation announced in `v1.x` may only be removed in `v2.0` or later.

---

## Checklist for maintainers (before every PR that touches inputs or outputs)

- [ ] Identify whether the change is breaking or non-breaking using the table above
- [ ] If **breaking** — bump MAJOR in the release, add a `## v(N) → v(N+1)` entry to [Change history](#change-history)
- [ ] If **deprecating** — add `# DEPRECATED` to `action.yml`, add `core.warning`, mark README table, add to [Deprecation history](#deprecation-history)
- [ ] Update `README.md` inputs/outputs table
- [ ] Confirm `action.yml` descriptions stay aligned with README (see [docs/RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md))

---

## Deprecation history

> This table is updated whenever an input or output enters the warn state.

| Input / Output | Deprecated in | Replacement | Planned removal |
|----------------|--------------|-------------|-----------------|
| _(none yet)_ | — | — | — |

---

## Change history

> Record breaking changes here when a new major version is released. Minor/patch changes are covered by GitHub Release notes.

### v1 (current)

Initial public release. No breaking changes from a prior major.

**Inputs (v1):** `stellar_address_input` (required), `github_token` (required), `horizon_url`, `asset_code`, `asset_issuer`, `min_xlm_reserve`, `fail_on_missing`, `debug_mode`, `horizon_timeout_ms`, `sticky_comment`, `wait_until_funded`, `wait_until_funded_timeout_ms`, `wait_until_funded_interval_ms`, `horizon_url_fallback`, `horizon_cache_ttl_ms`, `rpc_fallback_url`, `use_cache`, `log_inputs`, `trustbridge_config_path`, `max_retries`, `retry_base_delay_ms`, `sep0007_deep_links`, `sep0007_origin_domain`.

**Outputs (v1):** `trustline_exists`, `xlm_balance`, `account_funded`, `comment_url`.

### v1 → v2 (placeholder)

> _Not yet released. This section will be populated when the first breaking change is introduced._

---

[← Back to README](../README.md)
