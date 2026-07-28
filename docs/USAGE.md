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

---

## fail_on_missing patterns: Contributor vs. Maintainer gates (Issue #142)

TrustBridge provides two modes to match the workflow's trust model:

| Mode | `fail_on_missing` | When to use | Behavior on failure |
|------|-------------------|-------------|-------------------|
| **Hard-fail (maintainer gate)** | `true` (default) | Maintainer audit job or bounty payout (high trust, all checks must pass) | Workflow fails; requires manual intervention to proceed |
| **Warn-only (contributor-friendly)** | `false` | Contributor assignment workflow (low friction, guidance over blocking) | Workflow continues; contributor gets warning comment with remediation steps |

### Contributor-friendly assignment workflow

When assigning issues to contributors, use `fail_on_missing: false` to avoid blocking the assignment if the wallet isn't yet ready:

```yaml
name: Assign and check wallet (non-blocking)

on:
  issues:
    types: [assigned]

jobs:
  check-wallet:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: Extract address
        id: addr
        run: echo "value=GYOURCONTRIBUTORADDRESSHERE" >> "$GITHUB_OUTPUT"

      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: false   # don't fail; contributor can set up wallet afterward
```

**Result:**
- ✓ Issue assignment succeeds regardless of wallet status.
- ✓ Comment posted with clear remediation steps (fund account, add trustline, etc.).
- ✓ Contributor has a roadmap but isn't blocked.

### Maintainer-only payout audit workflow

For sensitive operations (bounty payouts, grants), use `fail_on_missing: true` to gate on strict wallet readiness:

```yaml
name: Bounty payout audit (maintainer gate)

on:
  workflow_dispatch:
    inputs:
      stellar_address:
        description: Contributor's Stellar address
        required: true

jobs:
  verify-and-payout:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.inputs.stellar_address }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          fail_on_missing: true    # hard-fail if wallet not ready
          min_xlm_reserve: '10'    # bounty threshold
          sticky_comment: true

      - name: Initiate payout
        run: |
          # Only runs if TrustBridge checks passed
          echo "Initiating payout to ${{ github.event.inputs.stellar_address }}"
          # your payout script here
```

**Result:**
- ✓ Workflow hard-fails if wallet is unfunded, missing trustline, or low on reserve.
- ✓ Prevents accidental mis-sends or stuck funds.
- ✓ Maintainer gets clear error message and comment explaining why.

### Bounty workflow with label gate + hard-fail

Combine the [label gate pattern](LABEL_GATE_DESIGN.md) with `fail_on_missing: true` to validate only when a `bounty` label is explicitly set:

```yaml
name: Verify Stellar wallet (label gate + hard-fail)

on:
  issues:
    types: [assigned]

jobs:
  trustbridge-gated:
    runs-on: ubuntu-latest
    permissions:
      issues: read
      issues: write
      contents: read
    steps:
      - name: TrustBridge with label gate
        id: gate
        uses: Stellar-TrustBridge/trustbridge-action/.github/actions/trustbridge-label-gate@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          stellar_address_input: GYOURCONTRIBUTORADDRESSHERE
          gate_labels: 'bounty'            # only validate if "bounty" label is present
          post_skip_comment: 'true'        # let contributor know why validation skipped
          fail_on_missing: 'true'          # hard-fail when gate is open

      - name: Process bounty
        if: steps.gate.outputs.gate_skipped != 'true' && steps.gate.outputs.account_funded == 'true'
        run: echo "✓ Ready for payout"

      - name: Alert on gate skip
        if: steps.gate.outputs.gate_skipped == 'true'
        run: echo "ℹ️  Add the 'bounty' label to trigger wallet validation"
```

**Result:**
- ✓ Assignment without `bounty` label: validation skipped, skip notice posted.
- ✓ Assignment with `bounty` label: validation runs, workflow hard-fails if wallet not ready.
- ✓ Different workflows can have different gates and thresholds (see [`trustbridge-label-gate-branching.yml`](examples/trustbridge-label-gate-branching.yml) for per-label rules).

### Key behavioral guarantees (test-documented)

| Scenario | `fail_on_missing=true` | `fail_on_missing=false` |
|----------|----------------------|------------------------|
| **All checks pass** | ✓ Step succeeds | ✓ Step succeeds |
| **Checks fail** | ✗ `core.setFailed()` — step fails, workflow fails | ⚠️ `core.warning()` — step succeeds, workflow continues |
| **Default** | Yes (safe by default) | — |

These guarantees are verified by comprehensive test matrix in [`__tests__/fail_on_missing.benchmark.test.ts`](../__tests__/fail_on_missing.benchmark.test.ts).

---

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

## Onboarding checklist (default on)

```yaml
with:
  github_token: ${{ secrets.GITHUB_TOKEN }}
  stellar_address_input: ${{ steps.address.outputs.address }}
  onboarding_checklist: true   # default — include live fund → trustline → balance checklist
```

The checklist section uses GitHub Markdown task-list checkboxes that reflect live Horizon validation (`accountFunded`, `trustlineExists`, `xlmReserveMet`) and links to [TROUBLESHOOTING.md](TROUBLESHOOTING.md) FAQ anchors. Set `onboarding_checklist: false` to omit it.

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

## Action outputs

### `comment_url`

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

### Readiness badge outputs

The action exposes badge snippets suitable for embedding in READMEs or dashboards:

- **`readiness_badge_markdown`** — Markdown-formatted badge with link to TrustBridge repository
- **`readiness_badge_url`** — Plain Shields.io badge URL reflecting wallet-check status (pass/fail)

#### Embedding in README

Add the badge to your repository README using the Markdown output:

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Update README with badge
  run: |
    # Example: update README with the latest badge status
    echo "Badge: ${{ steps.trustbridge.outputs.readiness_badge_markdown }}" >> README.md
```

#### Example badge output

**Pass state:** [![TrustBridge](https://img.shields.io/badge/trustbridge-Ready-brightgreen)](https://github.com/Stellar-TrustBridge/trustbridge-action)

**Fail state:** [![TrustBridge](https://img.shields.io/badge/trustbridge-Not%20Ready-red)](https://github.com/Stellar-TrustBridge/trustbridge-action)

The badge reflects the validation result without exposing PII (addresses, balances, or asset details).

### Sponsorship outputs

The action exposes sponsorship relationship counts from the Stellar Horizon API when available:

- **`num_sponsoring`** — Number of accounts this account is sponsoring (numeric string)
- **`num_sponsored`** — Number of accounts sponsoring this account (numeric string)

#### Using sponsorship outputs in workflows

Sponsorship outputs are useful for understanding reserve requirements and sponsorship relationships:

```yaml
- name: TrustBridge check
  id: trustbridge
  uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}

- name: Check sponsorship status
  run: |
    echo "Sponsoring: ${{ steps.trustbridge.outputs.num_sponsoring }} accounts"
    echo "Sponsored by: ${{ steps.trustbridge.outputs.num_sponsored }} accounts"
```

When an account is **sponsored** (`num_sponsored > 0`), reserve requirements are covered by the sponsoring account. The TrustBridge comment will automatically note this and provide links to Stellar sponsorship documentation for clarity.

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

## Handling oversized reports

Long remediation sections (multi-check failures, expert diagnostics, batch results) can push the comment body past GitHub's 65,536-byte limit. When that happens, TrustBridge automatically:

1. Writes the **full** validation report to a workspace file (`trustbridge-report.md` by default).
2. Posts a **truncated** comment with a notice explaining where to find the full report.
3. Sets the `full_report_path` output to the absolute path of the written file.

The file is only written when the body exceeds the limit — normal short comments are unchanged.

### Uploading the report as a workflow artifact

Add an `actions/upload-artifact` step **after** the TrustBridge step to make the full report available for download from the Actions run summary:

```yaml
jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
    steps:
      - name: TrustBridge check
        id: trustbridge
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ steps.addr.outputs.value }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: customise where the full report is written
          report_output_path: trustbridge-report.md

      - name: Upload full validation report
        if: steps.trustbridge.outputs.full_report_path != ''
        uses: actions/upload-artifact@v4
        with:
          name: trustbridge-full-report
          path: ${{ steps.trustbridge.outputs.full_report_path }}
          retention-days: 7
```

The `if:` condition means the upload step is skipped entirely on normal runs where the comment fit within the limit.

### Configuring the report path

Use the `report_output_path` input to change where the file is written:

```yaml
with:
  report_output_path: reports/trustbridge-${{ github.run_id }}.md
```

Intermediate directories are created automatically. The path can be workspace-relative or absolute.

### Outputs added by this feature

| Output | Description |
| ------ | ----------- |
| `full_report_path` | Absolute path of the written report file, or empty string when no file was written |

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

### Assignee → address roster map (`assignee_address_map`)

When wallets are stored out-of-band (org variable, private roster file, Actions secret), pass a JSON map of **GitHub username → Stellar G-address**. TrustBridge reads the assignee login from the GitHub event context (`payload.assignee` on `issues.assigned`, otherwise the first issue assignee) and resolves the address **before** calling Horizon — no issue-body parsing required.

**Inline JSON** (small public rosters or values injected from a secret):

```yaml
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
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Prefer injecting from a secret/org variable rather than hard-coding:
          assignee_address_map: ${{ vars.STELLAR_ASSIGNEE_ROSTER }}
          # Example shape: {"alice":"GABC...","bob":"GDEF..."}
```

**JSON file path** (checked out in the job workspace):

```json
{
  "alice": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "bob": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
}
```

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      github_token: ${{ secrets.GITHUB_TOKEN }}
      assignee_address_map: rosters/wallets.json
```

Usernames are matched **case-insensitively**. When the map is set, `stellar_address_input` is not required. Missing assignees fail with an actionable error; invalid G-addresses still go through the existing address validation before Horizon.

> **Security:** Do **not** commit private or sensitive rosters to a public repository. Prefer GitHub Actions secrets / org variables, a private repo path, or a checkout of a restricted artifact. Public exposure of username↔wallet links can deanonymize contributors.

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

## Security: validation.json and delta vs previous run

TrustBridge can emit a structured `validation.json` artifact and compare it to the **previous workflow run** so auditors see what newly passed or failed between cron revalidations (Issue #148).

### Recommended strategy: retain artifacts between runs

Download the previous run’s artifact into the job, then pass its path as `previous_validation_path`. Always upload the current `validation.json` (even on failure) so the next run can compare.

```yaml
name: TrustBridge cron revalidation

on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  trustbridge:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      actions: read   # needed only for download-artifact across runs
    steps:
      - name: Download previous validation artifact (optional)
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: trustbridge-validation
          path: previous-validation
          # For cross-run retention, prefer a dedicated store or
          # gh api + artifact ID lookup; see tradeoffs below.

      - name: TrustBridge check
        uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ vars.STELLAR_ADDRESS }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          write_validation_json: true
          validation_json_path: validation.json
          previous_validation_path: previous-validation/validation.json
          privacy_mode: true   # hash addresses in the JSON artifact

      - name: Upload validation artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: trustbridge-validation
          path: validation.json
          retention-days: 30
```

**First run:** if `previous_validation_path` is empty or the file is missing, TrustBridge **omits** the delta section and does not fail.

**Delta surfaces:**
- Issue comment section `### Delta vs previous run` (newly passed / newly failed / unchanged)
- Optional `delta` object inside `validation.json` when writing is enabled

### Strategy tradeoffs

| Approach | Pros | Cons |
| -------- | ---- | ---- |
| **Local artifact path** (`previous_validation_path`) — **recommended** | Explicit matching; no Actions API logic inside the action; soft-fails on first run | Consumer must download/retain artifacts (or copy from a known store) |
| **GitHub Actions API auto-discover** (not implemented) | Zero wiring for consumers | Needs `actions: read`; brittle around artifact names, matrix jobs, retention; rate limits |

`actions/download-artifact@v4` only downloads artifacts from the *current* workflow run by default. For cron-to-cron comparison, retain the file outside GitHub (S3, gist, commit to an internal branch) **or** use `gh api` / a custom step to fetch the previous successful run’s artifact ID, then pass the downloaded path to `previous_validation_path`.

### Privacy mode

When `privacy_mode: true`, addresses and asset issuers in `validation.json` (and its `delta`) are replaced with `sha256:<16 hex>` digests so retained artifacts and public logs do not expose raw G-/C-addresses. Issue comments still use full addresses for remediation. The artifact **never** includes `github_token` or auth headers.

### JSON schema (high level)

- `schemaVersion`, `timestamp`, `address`, `asset`, `horizonUrl`
- `readiness` — gate summary (`ready`, counts, failed labels)
- `checks[]` — `{ label, passed, detail }`
- `balances.xlm`
- `delta` — optional `{ newlyPassed, newlyFailed, unchanged, improved, regressed, previousTimestamp }`
- `privacyMode` — present when hashing was applied

---

## SARIF output for GitHub Advanced Security

TrustBridge can emit validation results as SARIF 2.1.0 for integration with GitHub Advanced Security (GHAS) code scanning. This allows wallet-check failures to appear alongside other security findings in the repository's Security tab.

### Enable SARIF output

Set the optional `sarif_output_path` input to a file path where the SARIF JSON will be written:

```yaml
steps:
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      stellar_address_input: ${{ steps.address.outputs.address }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      sarif_output_path: trustbridge-results.sarif

  - name: Upload SARIF results to GHAS
    if: always()  # run even if TrustBridge checks fail
    uses: github/codeql-action/upload-sarif@v2
    with:
      sarif_file: trustbridge-results.sarif
```

The SARIF file includes:
- **Rule definitions** — TB001 (account funded), TB002 (trustline), TB003 (XLM reserve), TB004 (Horizon availability)
- **Severity levels** — Passed checks appear as `note`, failed checks as `error`
- **Validation gate summary** — Total/passed/failed check counts in run properties
- **Locations** — Links to the Horizon endpoint and checked account address

### SARIF rule reference

| Rule ID | Check | Help link |
| ------- | ----- | --------- |
| TB001 | Account funded | [Stellar Accounts](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/accounts) |
| TB002 | Asset trustline | [Trustlines](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/account-data#trustlines) |
| TB003 | XLM reserve | [Reserves & Fees](https://developers.stellar.org/docs/learn/fundamentals/fees-and-metering#reserve) |
| TB004 | Horizon availability | [Horizon API](https://developers.stellar.org/docs/data/apis/horizon) |

---

## Internationalization (i18n)

Issue comments can be rendered in multiple languages. Set the optional `locale` input to change the comment language:

```yaml
steps:
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      stellar_address_input: ${{ steps.address.outputs.address }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      locale: 'es'  # Spanish
```

### Supported locales

| Locale | Language | Example comment |
| ------ | -------- | --------------- |
| `en` | English (default) | Check labels, remediation, setup cost all in English |
| `es` | Spanish | "Verificación de Cuenta Stellar", "Cuenta financiada", etc. |
| `pt` | Portuguese | "Verificação de Conta Stellar", "Conta financiada", etc. |

If an unsupported or invalid locale is provided, the action falls back to English (`en`).

### Example: LATAM campaign

```yaml
name: Verificar Billetera Stellar

on:
  issues:
    types: [assigned]

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: Stellar-TrustBridge/trustbridge-action@v1
        with:
          stellar_address_input: ${{ github.event.issue.body }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          locale: 'es'  # Comment in Spanish
          fail_on_missing: false  # Warn only; don't fail workflow
```

---

## Release SBOM (Software Bill of Materials)

TrustBridge publishes a Software Bill of Materials (SBOM) alongside each release for supply-chain security review.

### Accessing the SBOM

1. Go to the [TrustBridge releases page](https://github.com/Stellar-TrustBridge/trustbridge-action/releases)
2. Open a release (e.g., `v1.0.0`)
3. Download the attached `trustbridge-sbom.json` file

### SBOM format

The SBOM is generated in **CycloneDX JSON** format, which is widely supported by:
- [Dependency-Track](https://dependencytrack.org/) (software inventory platform)
- [NTIA SBOM Tool](https://github.com/ntia/sbom-pointers)
- GitHub's own [Dependency Scanning](https://docs.github.com/en/code-security/supply-chain-security)

### Verifying the SBOM

After downloading, you can verify its structure:

```bash
# Check that it's valid JSON
jq . trustbridge-sbom.json > /dev/null && echo "Valid SBOM"

# See all dependencies
jq '.components[] | {name, version}' trustbridge-sbom.json

# Check for a specific dependency
jq '.components[] | select(.name == "@actions/core")' trustbridge-sbom.json
```

### Using the SBOM in your supply chain

```bash
# Example: Submit to NTIA Tool for policy check
sbom-tool validate --input-format CycloneDX --input-file trustbridge-sbom.json

# Example: Import into Dependency-Track for monitoring
curl -X POST "https://your-dependency-track/api/v1/bom" \
  -H "X-API-Key: <your-key>" \
  -F "project=<project-uuid>" \
  -F "bom=@trustbridge-sbom.json"
```

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

## workflow_run chained triggers (#146)

Use `workflow_run` when you want TrustBridge to run as a trusted downstream job triggered by an upstream address-resolution workflow. This is common in organizations that separate the untrusted "read the issue" step from the trusted "validate and comment" step.

### Why use workflow_run instead of a direct issues: trigger?

| Scenario | Recommendation |
|----------|----------------|
| Simple: address in issue body, single repo | `issues: [assigned]` directly on the TrustBridge step |
| Complex: address from external API/bot, matrix payouts, fork trust isolation | `workflow_run` + artifact passing |

### Critical differences from a direct `issues:` trigger

1. **No issue context in `github.event`** — `workflow_run` events do not carry `github.event.issue`. You must pass the issue number from the upstream workflow via an artifact or repository variable.
2. **GITHUB_TOKEN has write access to the base repo** — correct for posting issue comments; safe even on fork-triggered `pull_request` or `issues` events.
3. **Re-runs are idempotent** — `sticky_comment: true` (default) ensures TrustBridge updates its existing comment rather than spamming the issue on each re-run.

### Required permissions

```yaml
permissions:
  issues: write      # post/update the TrustBridge comment
  contents: read     # standard
  actions: read      # download artifacts from the upstream run
```

### Passing the Stellar address between workflows

The upstream workflow uploads a JSON artifact; the downstream workflow reads it:

**Upstream (intake workflow):**
```yaml
- name: Upload TrustBridge inputs
  uses: actions/upload-artifact@v4
  with:
    name: trustbridge-inputs
    path: /tmp/trustbridge/inputs.json
    # inputs.json: {"stellar_address":"G...","issue_number":42}
```

**Downstream (TrustBridge workflow):**
```yaml
- uses: actions/download-artifact@v4
  with:
    name: trustbridge-inputs
    run-id: ${{ github.event.workflow_run.id }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    path: /tmp/trustbridge
```

### Injecting issue context

Because `workflow_run` events have no `payload.issue`, you must patch the event file before TrustBridge runs:

```yaml
- uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const eventPath = process.env.GITHUB_EVENT_PATH;
      const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
      event.issue = { number: parseInt('${{ steps.inputs.outputs.issue }}', 10) };
      fs.writeFileSync(eventPath, JSON.stringify(event));
```

### GITHUB_TOKEN limitations across repos

`GITHUB_TOKEN` can only post comments on the **same repository** as the workflow file. For cross-repo comment posting (rare), use a PAT with `repo` scope or a GitHub App token.

### Troubleshooting "comment skipped" in workflow_run context

If TrustBridge warns "No issue context found — skipping comment", the most common causes are:

| Cause | Fix |
|-------|-----|
| `github.event.issue` not injected | Add the "Inject issue context" step above |
| `issue_number` is `NaN` or `0` | Verify your `jq` command extracts a valid integer |
| Token lacks `issues: write` | Add `permissions: issues: write` to the job |
| Upstream workflow was a `push` or PR event | Only `issues`-context runs have issue numbers; use `workflow_dispatch` for manual checks |

See the complete working example: [docs/examples/workflow_run_chained.yml](examples/workflow_run_chained.yml)

---

## Per-check env vars for payout jobs (#147)

For payout bots and matrix workflows, TrustBridge supports a `TRUSTBRIDGE_*` environment variable layer so you can configure asset and network settings without duplicating `with:` inputs across matrix legs.

### Precedence

```
with: input  >  TRUSTBRIDGE_* env var  >  action.yml default
```

An explicit `with:` value always wins. The env var is only consulted when the `with:` value is empty.

### Supported env vars

| Env var | Maps to input | Notes |
|---------|--------------|-------|
| `TRUSTBRIDGE_HORIZON_URL` | `horizon_url` | |
| `TRUSTBRIDGE_HORIZON_URL_FALLBACK` | `horizon_url_fallback` | |
| `TRUSTBRIDGE_RPC_FALLBACK_URL` | `rpc_fallback_url` | |
| `TRUSTBRIDGE_ASSET_CODE` | `asset_code` | |
| `TRUSTBRIDGE_ASSET_ISSUER` | `asset_issuer` | |
| `TRUSTBRIDGE_MIN_XLM_RESERVE` | `min_xlm_reserve` | |
| `TRUSTBRIDGE_FAIL_ON_MISSING` | `fail_on_missing` | `true`/`false` |
| `TRUSTBRIDGE_DEBUG_MODE` | `debug_mode` | |
| `TRUSTBRIDGE_HORIZON_TIMEOUT_MS` | `horizon_timeout_ms` | |
| `TRUSTBRIDGE_STICKY_COMMENT` | `sticky_comment` | |
| `TRUSTBRIDGE_WAIT_UNTIL_FUNDED` | `wait_until_funded` | |
| `TRUSTBRIDGE_WAIT_UNTIL_FUNDED_TIMEOUT_MS` | `wait_until_funded_timeout_ms` | |
| `TRUSTBRIDGE_WAIT_UNTIL_FUNDED_INTERVAL_MS` | `wait_until_funded_interval_ms` | |
| `TRUSTBRIDGE_HORIZON_CACHE_TTL_MS` | `horizon_cache_ttl_ms` | |
| `TRUSTBRIDGE_USE_CACHE` | `use_cache` | |
| `TRUSTBRIDGE_LOG_INPUTS` | `log_inputs` | |
| `TRUSTBRIDGE_PREFLIGHT_ONLY` | `preflight_only` | |

**Not supported** (intentionally excluded): `github_token`, `stellar_address_input`. These must always be supplied via explicit `with:` inputs. Never place token values in environment variables where they may be printed to job logs.

### Matrix payout example

```yaml
strategy:
  matrix:
    include:
      - asset_code: USDC
        asset_issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
        min_xlm_reserve: '1.5'
      - asset_code: EURC
        asset_issuer: GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP
        min_xlm_reserve: '2.0'

env:
  TRUSTBRIDGE_ASSET_CODE:    ${{ matrix.asset_code }}
  TRUSTBRIDGE_ASSET_ISSUER:  ${{ matrix.asset_issuer }}
  TRUSTBRIDGE_MIN_XLM_RESERVE: ${{ matrix.min_xlm_reserve }}
  TRUSTBRIDGE_FAIL_ON_MISSING: 'true'

steps:
  - uses: Stellar-TrustBridge/trustbridge-action@v1
    with:
      stellar_address_input: ${{ steps.addr.outputs.value }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
      # asset_code, asset_issuer, min_xlm_reserve resolved from env vars above
```

See the full working example: [docs/examples/payout_matrix.yml](examples/payout_matrix.yml)

---

## issues:write preflight (#145)

TrustBridge automatically runs a **preflight check** before any Horizon calls to verify that the token can post issue comments. This prevents wasting Horizon API quota when permissions are misconfigured.

### What the preflight checks

1. **Issue context** — is there an issue number in the event payload? If not (e.g. `workflow_dispatch` without an issue), comment posting is silently skipped and Horizon runs normally.
2. **Token permission** — calls `GET /repos/{owner}/{repo}/issues/{number}/comments` (read-only). A 401 or 403 response fails the run immediately with a clear permission error before any Horizon work.

### Preflight-only mode

Set `preflight_only: true` to run only the permission check and exit without calling Horizon. Useful when setting up TrustBridge for the first time:

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.addr.outputs.value }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    preflight_only: true   # exits after permission check, no Horizon call
```

### Troubleshooting preflight failures

| Error | Cause | Fix |
|-------|-------|-----|
| `GitHub token lacks issues: write permission (403)` | Token scope too narrow | Add `permissions: issues: write` to the workflow job |
| `GitHub token is not authorized (401)` | Invalid or expired token | Verify the token / regenerate the PAT |
| `Issue #N was not found (404)` | Closed or deleted issue | Run the check on an open issue |

---

## Integrations and extension examples

### KYC gate (optional consumer logic)

Wave programs that require identity verification before payout can add an
optional KYC check via the [plugin architecture](PLUGIN_ARCHITECTURE.md).
A hardened reference example — with safe comment output, no PII in logs,
and full Markdown escaping — is available at:

- **Plugin source:** [`docs/examples/kyc-plugin.ts`](examples/kyc-plugin.ts)
- **Guide:** [`docs/examples/kyc-plugin.md`](examples/kyc-plugin.md)

The KYC plugin is **never enforced by default**. It only runs when you
explicitly register it alongside the core checks.

---

[← Back to README](../README.md)
