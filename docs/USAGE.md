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

## Ledger freshness guard

The freshness guard detects when a Horizon node is serving stale data by
comparing the latest ingested ledger close time to the current wall clock.

**Disabled by default** — set `check_ledger_freshness: true` to enable.

```yaml
with:
  stellar_address_input: ${{ steps.addr.outputs.value }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
  check_ledger_freshness: true
  max_ledger_lag_seconds: 60        # warn if Horizon is >60 s behind
  ledger_freshness_fail_on_stale: false   # false = warn only (default)
```

When `ledger_freshness_fail_on_stale: true` is set, a stale node causes the
action to hard-fail before running any account checks.

The guard fetches `GET <horizon_url>/` and reads
`history_latest_ledger_closed_at`. If the value is missing or unparseable,
the guard emits a warning and proceeds (fail-open) — a Horizon outage won't
cause a silent false-pass.

Freshness lag and latest ledger sequence are recorded as metrics
(`freshness_lag_seconds`, `freshness_latest_ledger`) and visible in the
`debug_mode: true` metrics JSON artifact.

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

## Soroban contract registry lookup

For programs that maintain an on-chain mapping of GitHub usernames to Stellar G-addresses via the `trustbridge-contract` registry, TrustBridge can resolve the address automatically before running Horizon checks.

### How it works

1. When `soroban_rpc_url`, `contract_id`, and `github_username` are all set, TrustBridge calls `get_address(github_username)` on the registry contract via `simulateTransaction`.
2. If the username is registered, the resolved G-address is used for all subsequent Horizon checks instead of `stellar_address_input`.
3. If the username is **not registered**, or the registry is **unavailable** (rate-limited, outage, timeout), TrustBridge logs a warning and falls back to `stellar_address_input` — existing workflows are never broken.

### Configuration

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `soroban_rpc_url` | No | `''` | Soroban RPC endpoint (e.g. `https://soroban-testnet.stellar.org`). Leave empty to skip registry lookup. |
| `contract_id` | No | `''` | C-address of the `trustbridge-contract` registry. Required when `soroban_rpc_url` is set. |
| `github_username` | No | `''` | GitHub username to resolve. Falls back to `stellar_address_input` if not registered. |

### Example — resolve assignee address from registry

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    github_username: ${{ github.event.assignee.login }}
    soroban_rpc_url: https://soroban-testnet.stellar.org
    contract_id: CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
    stellar_address_input: ${{ steps.addr.outputs.value }}  # fallback
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Rollout instructions

1. Deploy the `trustbridge-contract` registry to your target Stellar network.
2. Register contributor GitHub usernames via the contract's `set_address` function.
3. Add `soroban_rpc_url`, `contract_id`, and `github_username` to your workflow.
4. Keep `stellar_address_input` set as a fallback for contributors not yet registered.
5. Gradually migrate contributors to the registry; remove `stellar_address_input` once all are registered.

### Backward compatibility

All three inputs (`soroban_rpc_url`, `contract_id`, `github_username`) default to empty string. Existing workflows that do not set them are completely unaffected — the registry lookup is skipped entirely and the action behaves identically to previous versions.

---

## Structured Artifacts (Security & Auditing)

TrustBridge can emit a structured JSON artifact summarizing the check results for machine-readability, security reviews, and auditing. This avoids needing to parse markdown comments or action outputs.
By default, this feature is disabled.

To enable it, set `write_validation_json: 'true'`. You can then upload it using `actions/upload-artifact`:

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          write_validation_json: 'true'
          validation_json_path: 'validation.json' # Default

      - name: Upload Validation Artifact
        uses: actions/upload-artifact@v4
        if: always() # Ensure artifact is uploaded even if validation fails
        with:
          name: trustbridge-validation-artifact
          path: validation.json
```

**JSON Schema:**
The `validation.json` file contains:
- `timestamp`: ISO-8601 string of the validation time
- `address`: The evaluated Stellar account address
- `asset`: Object containing `code` and `issuer`
- `horizonUrl`: The Horizon API URL used for checks
- `readiness`: Object containing `ready` (boolean), `totalChecks`, `passedChecks`, `failedChecks`, and `failedLabels`
- `checks`: Array of per-check results
- `balances`: Object containing `xlm` balance string

> **Security Note:** The generated artifact is strictly filtered and will **never** contain the `github_token` or any authentication headers.

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

## GitHub App token guide

Some organizations restrict the default `GITHUB_TOKEN` to prevent cross-repo access or to enforce finer-grained permissions. In these cases, use a **GitHub App installation token** instead.

### Why use a GitHub App token?

| Concern | `GITHUB_TOKEN` | GitHub App token |
|---------|---------------|------------------|
| Cross-repo access | Limited to the current repo | Can be scoped to specific repos |
| Permission granularity | Fixed per-event permissions | Customizable per-app |
| Org policy compliance | May be blocked by org settings | Allowed when app is installed |
| Token rotation | Automatic (short-lived) | Manual rotation required |

### Setup steps

1. **Create a GitHub App** in your organization or personal account:
   - Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
   - Set the **Homepage URL** to your repo URL
   - Set the **Webhook URL** to a placeholder (not required for this use case)

2. **Grant permissions** to the App:
   - Under **Repository permissions**, grant:
     - **Issues**: `Read and write`
     - **Metadata**: `Read-only`
   - Under **Organization permissions**, grant only what is needed

3. **Install the App** on the target repository:
   - On the App settings page, click **Install** and select the repository

4. **Generate an installation access token** in your workflow:

```yaml
- name: Generate GitHub App token
  id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.GITHUB_APP_ID }}
    private-key: ${{ secrets.GITHUB_APP_PRIVATE_KEY }}
```

5. **Pass the token** to the action:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ steps.app-token.outputs.token }}
    fail_on_missing: true
```

### Security warnings

- **Do not log the token.** The action redacts `github_token` values in diagnostic output, but avoid printing it in workflow logs.
- **Rotate keys regularly.** GitHub App private keys should be rotated on a schedule. Delete old keys after generating new ones.
- **Use least privilege.** Grant only the permissions the App needs. The action requires `issues: write` to post comments.
- **Store secrets in GitHub Secrets.** Never commit private keys or App IDs to the repository.

### Events without issue context

When the action runs in a `workflow_dispatch` or `push` context (not an issue event), there is no issue to comment on. The action still performs all checks and sets outputs, but comment posting is skipped with a warning. This applies regardless of token type.

---

## Org-level policy inheritance

Integrators managing many repositories can centralize TrustBridge policy (asset, reserve, fail behavior) using **GitHub organization variables and secrets**, so child repos don't need to re-specify everything.

### Naming conventions

| Action input | Org variable/secret name | Description |
|-------------|--------------------------|-------------|
| `horizon_url` | `TRUSTBRIDGE_HORIZON_URL` | Horizon API base URL |
| `asset_code` | `TRUSTBRIDGE_ASSET_CODE` | Asset code for trustline verification |
| `asset_issuer` | `TRUSTBRIDGE_ASSET_ISSUER` | Issuer Stellar address |
| `min_xlm_reserve` | `TRUSTBRIDGE_MIN_XLM_RESERVE` | Minimum native XLM balance required |
| `fail_on_missing` | `TRUSTBRIDGE_FAIL_ON_MISSING` | `true` to fail, `false` to warn |
| `horizon_timeout_ms` | `TRUSTBRIDGE_HORIZON_TIMEOUT_MS` | Horizon request timeout |
| `sticky_comment` | `TRUSTBRIDGE_STICKY_COMMENT` | Update previous comment instead of posting new one |
| `wait_until_funded` | `TRUSTBRIDGE_WAIT_UNTIL_FUNDED` | Poll until account is funded |

### Reusable workflow example

Create `.github/workflows/trustbridge.yml` in the organization template repo:

```yaml
name: TrustBridge — Stellar wallet check

on:
  issues:
    types: [assigned]
  workflow_dispatch:
    inputs:
      stellar_address:
        description: 'Stellar G-address to validate'
        required: true

jobs:
  verify-stellar-account:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          horizon_url: ${{ vars.TRUSTBRIDGE_HORIZON_URL }}
          asset_code: ${{ vars.TRUSTBRIDGE_ASSET_CODE }}
          asset_issuer: ${{ vars.TRUSTBRIDGE_ASSET_ISSUER }}
          min_xlm_reserve: ${{ vars.TRUSTBRIDGE_MIN_XLM_RESERVE }}
          fail_on_missing: ${{ vars.TRUSTBRIDGE_FAIL_ON_MISSING }}
          horizon_timeout_ms: ${{ vars.TRUSTBRIDGE_HORIZON_TIMEOUT_MS }}
          sticky_comment: ${{ vars.TRUSTBRIDGE_STICKY_COMMENT }}
          wait_until_funded: ${{ vars.TRUSTBRIDGE_WAIT_UNTIL_FUNDED }}
```

### Override precedence

Explicit action inputs always win over org variable defaults. The precedence order is:

1. **Action input** (explicit value in the workflow step)
2. **Org variable** (set via `vars` or `secrets`)
3. **Default value** (the built-in default in `action.yml`)

This means a repo can override the org default by setting an explicit input, while repos that omit the input inherit the org-level policy.

### Using org secrets for sensitive values

For values that should not be visible in the repository settings UI (e.g., custom Horizon URLs with embedded tokens), use **GitHub Secrets** instead of Variables:

```yaml
horizon_url: ${{ secrets.TRUSTBRIDGE_HORIZON_URL }}
```

Secrets are masked in workflow logs and are not visible to repository collaborators.

### Org policy enforcement

GitHub organization rulesets can enforce that certain workflows use the centralized TrustBridge configuration. Mention this as a possibility — rulesets can require the `trustbridge.yml` config file or specific workflow inputs to be present, but TrustBridge itself does not enforce rulesets programmatically.

---

## Extracting Stellar addresses from issues
