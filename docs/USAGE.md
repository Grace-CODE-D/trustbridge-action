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

## Permissions reference

```yaml
permissions:
  issues: write    # required for comments
  contents: read   # standard for checkout-less actions
```

If using `GITHUB_TOKEN`, no extra secret is required beyond workflow permissions.

---

[← Back to README](../README.md)
