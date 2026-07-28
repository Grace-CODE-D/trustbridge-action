# Usage guide

How to integrate **trustbridge-action** into your repository workflows.

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Error handling](ERROR_HANDLING.md)

---

## Prerequisites

1. A GitHub repository with Actions enabled
2. A Stellar **G-address** to validate (contributor wallet)
3. Workflow permissions allowing issue comments

---

## Basic workflow — issue assignment

```yaml
name: Verify Stellar wallet on assignment

on:
  issues:
    types: [assigned]

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Replace `GCONTRIBUTORADDRESSHERE` with your project's method of obtaining the address (see [Extracting addresses](#extracting-stellar-addresses-from-issues)).

---

## Manual run — workflow_dispatch

```yaml
on:
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address'
        required: true

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: false   # warn only for manual checks
```

> **Note:** Comments are only posted when the workflow runs in an **issue** context. For standalone `workflow_dispatch` without an open issue, checks still run and outputs are set; comment posting is skipped with a warning.

---

## Combined trigger (assigned + manual)

Matches the action design target. Use `issue_number` on `workflow_dispatch` runs to target a specific issue for the result comment (Wave #29):

```yaml
on:
  issues:
    types: [assigned]
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address (manual runs)'
        required: true
      issue_number:
        description: 'Issue number to post result on (manual runs only)'
        required: false

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: Resolve address
        id: addr
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "value=${{ github.event.inputs.stellar_address }}" >> "$GITHUB_OUTPUT"
          else
            echo "value=GYOURDEFAULTORPARSEDADDRESS" >> "$GITHUB_OUTPUT"
          fi

      - uses: Stellar-TrustBridge/trustbridge-action@v1
        id: bridge
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          issue_number: ${{ github.event.inputs.issue_number }}
          github_token: ${{ secrets.GITHUB_TOKEN }}

      - name: Log results
        run: |
          echo "trustline_exists=${{ steps.bridge.outputs.trustline_exists }}"
          echo "xlm_balance=${{ steps.bridge.outputs.xlm_balance }}"
          echo "account_funded=${{ steps.bridge.outputs.account_funded }}"
```

---

## Custom asset (non-USDC)

```yaml
with:
  stellar_address_input: ${{ steps.addr.outputs.value }}
  asset_code: EURC
  asset_issuer: GISSUERADDRESSHERE
  min_asset_balance: '100'
  min_xlm_reserve: '2.0'
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Testnet

Point Horizon at Stellar testnet:

```yaml
with:
  horizon_url: https://horizon-testnet.stellar.org
  asset_code: USDC
  asset_issuer: GTESTNETISSUER...
  stellar_address_input: GTESTNETADDRESS...
  github_token: ${{ secrets.GITHUB_TOKEN }}
  fail_on_missing: false
```

Use [Stellar Laboratory (testnet)](https://laboratory.stellar.org/#account-viewer?network=test) for test accounts.

---

## Warn instead of fail

For informational checks (e.g. onboarding reminders):

```yaml
with:
  fail_on_missing: false
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.addr.outputs.value }}
```

The step succeeds with `core.warning()`; the issue comment still shows ❌ for failed checks.

## Debug mode and timeout

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.addr.outputs.value }}
  debug_mode: true
  horizon_timeout_ms: 20000
```

- `debug_mode: true` enables extra action logs for troubleshooting.
- `horizon_timeout_ms` controls Horizon request timeout in milliseconds.

## Sticky comments across re-runs

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  sticky_comment: true   # default — update the previous comment instead of posting a new one
```

Set `sticky_comment: false` if you want a new comment posted on every run instead (e.g. for a full audit trail). See [Comment guide](COMMENT_GUIDE.md) for details on how the prior comment is located.

## Waiting for the account to be funded

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  wait_until_funded: true
  wait_until_funded_timeout_ms: 120000
  wait_until_funded_interval_ms: 5000
```

Use this when contributors are expected to fund their wallet right after assignment. The action polls `GET /accounts/{id}` every `wait_until_funded_interval_ms` until it stops 404ing or `wait_until_funded_timeout_ms` elapses, then proceeds exactly as it would for a single check (comment, outputs, `fail_on_missing`). Non-404 Horizon errors (rate limits, outages, timeouts) are not retried by the polling loop — the existing per-request retry/backoff in `horizon.ts` handles those, and if they're still failing after that, the run fails fast instead of continuing to poll.

## New output: `comment_url`

When the action runs in an issue context, it sets `comment_url` to the created GitHub comment URL.

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Capture comment URL
  run: echo "Comment URL: ${{ steps.trustbridge.outputs.comment_url }}"
```

---

## `workflow_call` reusable workflow

If your org runs TrustBridge across many repos, wrap the action in a reusable workflow once and have every repo call it via `uses:` instead of copying the same job YAML everywhere.

Copy-paste starting points (validated as YAML):

- [docs/examples/trustbridge-reusable.yml](examples/trustbridge-reusable.yml) — the callable workflow. Publish it at `.github/workflows/trustbridge-reusable.yml` in an org-level shared-workflows repo (or in this repo, as shown).
- [docs/examples/trustbridge-caller.yml](examples/trustbridge-caller.yml) — an example consumer workflow that calls it.

### Inputs

All `workflow_call` inputs mirror `action.yml` inputs (see [README inputs table](../README.md#inputs)) except `github_token`, which is a secret (below). Types are widened to `boolean`/`number` where the underlying action input is boolean/numeric so callers get YAML-native typing instead of raw strings:

| `workflow_call` input | Type | Default | Maps to action input |
| --------- | ------ | --------- | ----------------------- |
| `stellar_address_input` | string | — (required) | `stellar_address_input` |
| `horizon_url` | string | `https://horizon.stellar.org` | `horizon_url` |
| `horizon_url_fallback` | string | `''` | `horizon_url_fallback` |
| `rpc_fallback_url` | string | `''` | `rpc_fallback_url` |
| `asset_code` | string | `USDC` | `asset_code` |
| `asset_issuer` | string | (default USDC issuer) | `asset_issuer` |
| `min_xlm_reserve` | string | `1.5` | `min_xlm_reserve` |
| `fail_on_missing` | boolean | `true` | `fail_on_missing` |
| `debug_mode` | boolean | `false` | `debug_mode` |
| `sticky_comment` | boolean | `true` | `sticky_comment` |
| `wait_until_funded` | boolean | `false` | `wait_until_funded` |
| `wait_until_funded_timeout_ms` | number | `120000` | `wait_until_funded_timeout_ms` |
| `wait_until_funded_interval_ms` | number | `5000` | `wait_until_funded_interval_ms` |
| `horizon_timeout_ms` | number | `15000` | `horizon_timeout_ms` |
| `horizon_cache_ttl_ms` | number | `60000` | `horizon_cache_ttl_ms` |
| `use_cache` | boolean | `false` | `use_cache` |
| `trustbridge_config_path` | string | `.trustbridge.yml` | `trustbridge_config_path` |
| `log_inputs` | boolean | `false` | `log_inputs` |
| `sep0007_deep_links` | boolean | `false` | `sep0007_deep_links` |
| `sep0007_origin_domain` | string | `''` | `sep0007_origin_domain` |

### Outputs

| `workflow_call` output | Maps to action output |
| --------- | ------------------------ |
| `trustline_exists` | `trustline_exists` |
| `xlm_balance` | `xlm_balance` |
| `account_funded` | `account_funded` |
| `comment_url` | `comment_url` |

Read them from the calling workflow via `needs.<job-id>.outputs.<name>`, same as any other reusable-workflow job.

### Secrets

| Secret | Required | Notes |
| --------- | ---------- | ------- |
| `github_token` | No | Token with `issues: write` used to post/update the comment. Most callers should use `secrets: inherit` at the call site, which forwards the caller's own `GITHUB_TOKEN` (and any other secrets) under the same names — the reusable workflow reads it as `secrets.github_token`. The reusable workflow also falls back to `github.token` if no secret is supplied, so `secrets: inherit` is convenience, not a hard requirement. |

### Permissions

The reusable workflow's job declares `permissions: { issues: write, contents: read }` itself, but the **caller** workflow also needs at least `issues: write` in its own `permissions:` block (or org/repo default permissions must allow it) for the forwarded token to be able to post comments.

### Issue context limitations when called from non-`issues` events

TrustBridge posts a comment only when the workflow run's triggering event carries an issue payload (`github.context.payload.issue`). For a reusable workflow, that payload comes from whatever event triggered the **caller** workflow run — not from `workflow_call` itself, which has no event payload of its own. Concretely:

- Caller triggered by `issues: assigned` → issue context is present, comment posting works normally.
- Caller triggered by `workflow_dispatch`, `schedule`, `push`, etc. → there is no issue context, so `postIssueComment` logs a warning and skips posting (checks and outputs still run normally). This matches the action's existing standalone behavior — see the "Manual run — workflow_dispatch" section above.
- If you need comments from a non-`issues` trigger, pass an issue number explicitly to your own comment step rather than relying on TrustBridge's built-in poster, or trigger the caller workflow from an `issues` event alongside `workflow_dispatch` as shown in `trustbridge-caller.yml`.

---

## Extracting Stellar addresses from issues

Common patterns:

### Automatic extraction via `extract_address_from_issue`

Parse a labeled line from a free-form Markdown issue body (classic `.md`/`.yml` issue templates, or any issue where contributors paste an address in a known format):

```yaml
- name: Extract Stellar address
  id: stellar
  uses: actions/github-script@v7
  with:
    script: |
      const body = context.payload.issue?.body ?? '';
      const match = body.match(/Stellar address:\s*(G[A-Z2-7]{55})/i);
      if (!match) core.setFailed('No Stellar address found in issue body');
      core.setOutput('address', match[1]);
```

### Assignee-linked profile

Fetch a custom field or org profile via your own API step, then pass the result to `stellar_address_input`.

---

## Per-check named outputs (fine-grained gating)

In addition to the legacy `account_funded` and `trustline_exists` outputs,
TrustBridge exposes three named per-check outputs that map one-to-one onto
the internal validation checks:

| Output | Type | Description |
|--------|------|-------------|
| `check_account_funded` | `'true'`/`'false'` | Account exists and is funded on Stellar |
| `check_trustline` | `'true'`/`'false'` | Trustline for `asset_code`/`asset_issuer` is present |
| `check_xlm_reserve` | `'true'`/`'false'` | Native XLM ≥ `min_xlm_reserve` |

These are backward-compatible additions — all existing `account_funded`,
`trustline_exists`, and `xlm_balance` outputs continue to work unchanged.

### Branching workflow: allow funded-but-trustline-pending path

A common pattern is to let contributors proceed when the account is funded
even if the trustline is not yet set up (e.g. to unblock an issue assignment
while the contributor completes wallet configuration):

```yaml
- name: TrustBridge check
  id: tb
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.addr.outputs.value }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    fail_on_missing: false   # don't hard-fail; we branch on outputs below

- name: Full payout path — all checks passed
  if: >
    steps.tb.outputs.check_account_funded == 'true' &&
    steps.tb.outputs.check_trustline == 'true' &&
    steps.tb.outputs.check_xlm_reserve == 'true'
  run: echo "Ready for immediate payout"

- name: Funded but trustline or reserve pending — assign but hold payment
  if: >
    steps.tb.outputs.check_account_funded == 'true' &&
    (steps.tb.outputs.check_trustline != 'true' ||
     steps.tb.outputs.check_xlm_reserve != 'true')
  run: echo "Account active — awaiting trustline/reserve setup before payout"

- name: Account not funded — block assignment
  if: steps.tb.outputs.check_account_funded != 'true'
  run: |
    echo "Contributor wallet not yet funded — blocking assignment"
    exit 1
```

### Reserve-only gating

Gate a step purely on whether the XLM reserve is met, independent of the
trustline check:

```yaml
- name: Assert reserve met
  if: steps.tb.outputs.check_xlm_reserve != 'true'
  run: |
    echo "XLM reserve not met (balance: ${{ steps.tb.outputs.xlm_balance }})"
    exit 1
```

---

## Outputs in downstream jobs

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    outputs:
      funded: ${{ steps.bridge.outputs.account_funded }}
    steps:
      - id: bridge
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: G...
          github_token: ${{ secrets.GITHUB_TOKEN }}

  payout:
    needs: verify
    if: needs.verify.outputs.funded == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Ready for payout pipeline"
```

> **Balance parsing for release scripts:** The `xlm_balance` output is a raw
> Horizon decimal string (e.g. `"14.9999700"`). Use `parseFloat()` for
> threshold comparisons, integer stroop arithmetic for payment math, or
> `BigInt` for auditable precision. See
> [DECIMAL_PRECISION.md](DECIMAL_PRECISION.md) for safe-parsing examples and
> rules to avoid floating-point bugs in downstream payout scripts.

---

## Pinning versions

| Reference | When to use |
| --------- | ------------- |
| `@v1` | Recommended for production (semver major) |
| `@main` | Latest development — use for testing only |
| `@abc1234` | Pin to commit SHA for maximum reproducibility |

---

## GitHub Enterprise Server (GHES) support

**Support statement: best-effort.** TrustBridge is not tested against a live GHES instance in CI (no GHES infra is currently available to this project), but the code path that talks to the GitHub REST API — issue comment posting in `src/comment.ts` — is written to respect the enterprise API base rather than assume `github.com`, and is covered by mocked-API-base tests (`__tests__/comment.test.ts`). Horizon/Stellar checks themselves (`src/horizon.ts`) make no GitHub API calls at all, so they behave identically on GHES and github.com.

### What changes on GHES

On a GHES runner, the Actions runner sets `GITHUB_API_URL` (and `GITHUB_SERVER_URL`, `GITHUB_GRAPHQL_URL`) to your enterprise instance's endpoints instead of the public GitHub ones, e.g.:

```bash
GITHUB_API_URL=https://ghes.example.com/api/v3
GITHUB_SERVER_URL=https://ghes.example.com
```

`@actions/github`'s `context.apiUrl` reads `GITHUB_API_URL` automatically. TrustBridge passes it explicitly as `baseUrl` when constructing its Octokit client (`github.getOctokit(token, { baseUrl: context.apiUrl })` in `postIssueComment`), so REST calls (`listComments`, `createComment`, `updateComment`) target your enterprise API instead of `api.github.com`. No workflow input needs to change for this — it's automatic based on where the runner executes.

### Verification checklist (no live GHES instance required)

Run through this on your own GHES org before relying on TrustBridge there:

- [ ] Runner is a **self-hosted runner registered to the GHES instance** (GHES doesn't offer GitHub-hosted runners) — confirm `runs-on:` targets a valid self-hosted label.
- [ ] `GITHUB_TOKEN` (or the PAT passed as `github_token`) has `issues: write` scope/permission on the target repo.
- [ ] The workflow's `permissions:` block includes `issues: write`, `contents: read`.
- [ ] Your GHES version supports the REST endpoints TrustBridge uses (`GET /repos/{owner}/{repo}/issues/{n}/comments`, `POST`/`PATCH` on the same) — these are core Issues API endpoints present since early GHES releases; no minimum version issue is currently known.
- [ ] Network egress from the GHES runner to the public Horizon API (`https://horizon.stellar.org` or your configured `horizon_url`) is allowed — GHES runners are often on restricted networks, and Horizon itself is **not** an enterprise-mirrored service (out of scope for this issue; see Horizon RPC fallback docs above if you run a private Horizon mirror).

### Troubleshooting GHES 404 / permission errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Could not look up existing TrustBridge comment, falling back to a new comment: ... 404` or similar on every run | `getOctokit` hit `api.github.com` instead of your GHES instance (e.g. an old TrustBridge version without the `baseUrl` fix, or `GITHUB_API_URL` unset because the runner isn't actually GHES-registered) | Upgrade to a TrustBridge version that includes the GHES `baseUrl` fix; confirm the job actually runs on a GHES-registered self-hosted runner (`echo $GITHUB_API_URL` in a debug step) |
| `403`/`Resource not accessible by integration` when posting the comment | Token lacks `issues: write`, or your GHES instance enforces stricter default token permissions than github.com | Add `permissions: { issues: write }` to the job/workflow; for a PAT, confirm it has `repo` (classic) or `issues:write` (fine-grained) scope on that specific repo |
| Comment posts to the wrong host / link in the comment 404s | `comment_url` output correctly reflects whatever host answered the API call — a wrong host here means `GITHUB_API_URL`/`GITHUB_SERVER_URL` are misconfigured on the runner itself, not a TrustBridge issue | Check the self-hosted runner's environment / `_work/_temp` runner config for correct GHES URLs |

---

## Permissions reference

### Minimum permissions

```yaml
permissions:
  issues: write    # required to post or update issue comments
  contents: read   # standard for checkout-less actions
```

`issues: write` is the only permission TrustBridge needs. `contents: read` is not strictly required unless you also check out the repository in the same job, but it is good practice to include it so the permission block documents the full job surface.

### When `GITHUB_TOKEN` is enough

| Trigger | `GITHUB_TOKEN` sufficient? | Notes |
|---------|---------------------------|-------|
| `issues: assigned` on default branch | ✅ Yes | Standard case — token is scoped to the repo |
| `workflow_dispatch` | ✅ Yes | Same repo, no fork isolation |
| `pull_request` from a fork | ❌ No | Fork PRs run with a read-only token; comment posting will fail with 403 |
| Repository under org with restricted Actions token | ❌ Depends | Check **Organization → Settings → Actions → General → Workflow permissions** |
| GitHub Enterprise Server (GHES) | ❌ Often needs PAT | Default token scopes vary by GHES version and admin policy |

### When you need a PAT or GitHub App token

Use a fine-grained PAT (or a GitHub App installation token) when:

- The workflow is triggered by a **fork pull request** (`pull_request` event from a forked repo). Fork PRs receive a restricted token with no write access. Store the PAT as an Actions secret: `${{ secrets.MY_TRUSTBRIDGE_TOKEN }}`.
- Your organization policy **sets default token permissions to read-only**. A PAT or App token scoped to `Issues: Read and write` bypasses the org policy.
- You are on **GHES** and the instance admin has not granted `issues: write` to the default token.

For GitHub Apps: request the **Issues (read and write)** permission during app registration, then pass the generated installation token via `${{ steps.generate_token.outputs.token }}`.

### Troubleshooting 403 / 404 comment errors

| Error | Likely cause | Fix |
|-------|-------------|-----|
| `Resource not accessible by integration` (403) | Token lacks `issues: write` | Add `permissions: issues: write` to the job or use a PAT |
| `Not Found` (404) when posting a comment | Issue was deleted, transferred, or the repo has issues disabled | Verify the issue exists and issues are enabled |
| `GitHub Actions is not permitted to create or approve pull requests` | Wrong permission for PRs (not needed by TrustBridge) | Ensure you are on the `issues` trigger, not `pull_request` |
| Comment posted but empty / malformed | Snapshot mismatch in comment format | Open a bug report with the action log excerpt |
| Comment not posted, no error | Workflow not running in issue context | Expected for `workflow_dispatch` without issue number; outputs are still set |

### Least-privilege example

```yaml
name: TrustBridge — Stellar wallet check

on:
  issues:
    types: [assigned]

jobs:
  verify-stellar-account:
    runs-on: ubuntu-latest
    permissions:
      issues: write     # allow TrustBridge to post comments
      contents: read    # standard read access
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: GCONTRIBUTORADDRESSHERE
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

This is the minimal permission block. Do not add `pull-requests: write`, `id-token: write`, or other scopes unless a separate step in the same job requires them.

---

[← Back to README](../README.md)
