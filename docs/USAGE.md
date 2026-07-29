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

Matches the action design target:

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
        description: 'Optional issue number for context'
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
  min_xlm_reserve: '2.0'
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Testnet campaign presets

Run dry Waves or onboard contributors on Stellar testnet using first-class campaign presets (`network: testnet` or `preset: testnet`):

```yaml
with:
  network: testnet
  stellar_address_input: GTESTNETADDRESS...
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

Using `network: testnet` automatically populates:
- **Horizon URL:** `https://horizon-testnet.stellar.org`
- **Asset Code:** `USDC`
- **Asset Issuer:** `GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2` (Circle Testnet USDC issuer)
- **Minimum XLM Reserve:** `1.5`

> **Network safety validation:**
> TrustBridge validates network compatibility before fetching account data. Combining a testnet Horizon endpoint with a mainnet asset issuer (e.g. mainnet USDC `GA5ZSEJY...`) fails fast with an explicit error to prevent accidental configuration errors.

---

## Canary & secondary endpoint failover

To protect Wave validation jobs against transient Horizon regional or provider outages, configure a secondary failover Horizon URL:

```yaml
with:
  horizon_url: https://horizon.stellar.org
  secondary_horizon_url: https://horizon-canary.stellar.org
  stellar_address_input: ${{ steps.addr.outputs.value }}
  github_token: ${{ secrets.GITHUB_TOKEN }}
```

- **Failover behavior:** When the primary Horizon URL fails after exponential retries due to a retryable error (HTTP 5xx, 429 rate limits, or network timeout), TrustBridge transparently attempts the secondary Horizon URL before declaring failure.
- **Definitive 404s skipped:** If Horizon returns a 404 (account missing / not funded), failover is skipped immediately because 404 is a non-retryable account state, not a transport outage.
- **Cross-network guard:** Failover between different networks (e.g. mainnet to testnet) is disabled by default (`allow_cross_network_failover: false`) to avoid silent network context shifts.
- **Observability:** Issue comments and debug logs reflect whether the primary or secondary Horizon base URL served the response.

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

## Extracting Stellar addresses from issues

Common patterns:

### Issue template field

Parse a labeled line from the issue body:

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

---

## Pinning versions

| Reference | When to use |
| --------- | ------------- |
| `@v1` | Recommended for production (semver major) |
| `@main` | Latest development — use for testing only |
| `@abc1234` | Pin to commit SHA for maximum reproducibility |

---

## Permissions reference

```yaml
permissions:
  issues: write    # required for comments
  contents: read   # standard for checkout-less actions
```

If using `GITHUB_TOKEN`, no extra secret is required beyond workflow permissions.

---

[← Back to README](../README.md)
