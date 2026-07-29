# TrustBridge Action — FAQ

This document answers the most common questions contributors and maintainers encounter when using TrustBridge. Each section has a stable anchor that TrustBridge links to directly from failing check bullets in issue comments.

---

## Account not funded {#account-not-funded}

**Symptom:** The `account_funded` check shows ❌ and the comment says the account was not found on Horizon.

**What this means:** Your Stellar public key exists but the account has not been activated on the network yet. A Stellar account must receive at least **1 XLM** before it appears on the ledger.

**Steps to fix:**

1. Copy your Stellar public key (G-address) from your wallet.
2. Send **at least 1 XLM** to that address from an exchange (Coinbase, Kraken, Binance) or another funded Stellar account.
3. Wait ~5 seconds for the ledger to close.
4. Re-run the TrustBridge check — either by reassigning the issue or triggering a `workflow_dispatch`.

**Helpful links:**
- [Stellar Laboratory — Account Viewer](https://laboratory.stellar.org/#account-viewer?network=public)
- [LOBSTR wallet](https://lobstr.co/) — buy or receive XLM on mobile
- [Stellar docs: Account minimum balance](https://developers.stellar.org/learn/fundamentals/lumens#minimum-balance)

---

## Trustline missing {#trustline-missing}

**Symptom:** The `trustline_exists` check shows ❌.

**What this means:** Your account is funded but has not yet established a trustline for the required asset (e.g. USDC). A trustline is a permission record that lets your account hold and receive a specific asset.

**Steps to fix:**

1. Open [Stellar Laboratory — Transaction Builder](https://laboratory.stellar.org/#txbuilder?network=public).
2. Set the source account to your G-address.
3. Add a **Change Trust** operation with the asset code (`USDC`) and issuer address shown in the comment.
4. Sign and submit the transaction.

Alternatively, use a SEP-0007-compatible wallet (LOBSTR, Solar, Albedo) — TrustBridge embeds a one-click `web+stellar:` deep link in the comment when `sep0007_deep_links: true` is configured.

**Helpful links:**
- [LOBSTR — Add trustline guide](https://lobstr.co/blog/how-to-add-trustline-on-stellar)
- [Stellar docs: Trustlines](https://developers.stellar.org/learn/fundamentals/stellar-data-structures/accounts#trustlines)

---

## XLM reserve too low {#xlm-reserve-too-low}

**Symptom:** The `check_xlm_reserve` check shows ❌.

**What this means:** Your account is funded and has a trustline, but your XLM balance is below the required reserve. The Stellar protocol requires each account to maintain a minimum balance based on its subentries (trustlines, offers, etc.).

**How the reserve is calculated:**

```
protocol minimum = (2 + subentries + sponsoring − sponsored) × 0.5 XLM
```

TrustBridge then applies your configured `min_xlm_reserve` as a floor — your balance must meet whichever is higher.

**Steps to fix:**

Send additional XLM to your address to bring the balance above the required threshold shown in the comment.

**Helpful links:**
- [Stellar docs: Minimum balance](https://developers.stellar.org/learn/fundamentals/lumens#minimum-balance)
- [Stellar docs: Sponsorship (CAP-0033)](https://developers.stellar.org/docs/learn/encyclopedia/transactions-specialized/sponsored-reserves)

---

## Testing on testnet {#testing-on-testnet}

**Symptom:** You want to test TrustBridge without using real XLM.

**Steps to configure testnet:**

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    horizon_url: https://horizon-testnet.stellar.org
    asset_code: USDC
    asset_issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
    min_xlm_reserve: '1.5'
```

Get free testnet XLM from the [Stellar Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS).

**Important:** Testnet accounts and mainnet accounts are independent — a G-address funded on testnet is **not** funded on mainnet.

**Helpful links:**
- [Stellar Friendbot](https://friendbot.stellar.org/)
- [Horizon testnet endpoint](https://horizon-testnet.stellar.org)
- [Stellar Laboratory (testnet)](https://laboratory.stellar.org/#account-viewer?network=testnet)

---

## Horizon error / service unavailable {#horizon-error}

**Symptom:** All checks show ❌ with a Horizon connectivity error, or the `wallet: horizon-error` label appears.

**What this means:** TrustBridge could not reach the Horizon API. This is usually a transient network issue, Horizon maintenance, or a misconfigured `horizon_url`.

**Steps to fix:**

1. Check [Stellar Status](https://status.stellar.org/) for known Horizon incidents.
2. Verify your `horizon_url` input is correct (`https://horizon.stellar.org` for mainnet).
3. If using a private Horizon mirror, confirm it is reachable from GitHub Actions runners.
4. Re-trigger the workflow after the outage resolves.

For high-availability workflows, configure a fallback URL:

```yaml
with:
  horizon_url: https://horizon.stellar.org
  horizon_url_fallback: https://horizon-testnet.stellar.org  # replace with your own mirror
```

**Helpful links:**
- [Stellar Status page](https://status.stellar.org/)
- [TrustBridge RPC fallback docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#horizon-rpc-fallback-url)

---

## Debug mode and expert diagnostics {#debug-mode}

**Symptom:** You need detailed Horizon status codes, latency, and normalized inputs to diagnose a failure.

**How to enable:**

```yaml
- uses: Stellar-TrustBridge/trustbridge-action@v1
  with:
    stellar_address_input: ${{ steps.address.outputs.address }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    debug_mode: true
```

When `debug_mode: true`:
- Extra `core.debug` lines are emitted to the Actions log covering every stage of the Horizon client.
- An **Expert diagnostics** collapsible section is appended to the issue comment showing the Horizon HTTP status, round-trip latency, retry count, and normalized inputs. No secrets are included — addresses are redacted to first-4/last-4.

**Helpful links:**
- [TrustBridge debug logging docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/README.md#debug-logging-and-redaction)

---

## Signed webhook not received {#webhook-not-received}

**Symptom:** Your dashboard is not receiving TrustBridge webhook notifications.

**Steps to diagnose:**

1. Confirm `webhook_url` is set in your workflow and points to an HTTPS endpoint.
2. Verify the endpoint is publicly reachable from GitHub Actions runner IPs.
3. Check the Actions log for `[TrustBridge] Webhook delivered` or `Webhook delivery failed` messages.
4. If the signature doesn't match, verify `webhook_secret` is the same value your receiver uses to verify signatures.

**Signature verification example (Node.js):**

```js
const crypto = require('crypto');

function verifySignature(payload, secret, signatureHeader) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(payload, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

**Helpful links:**
- [TrustBridge webhook docs](https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/USAGE.md#signed-dashboard-webhooks)
- [Issue #101 — Signed webhooks design](https://github.com/Stellar-TrustBridge/trustbridge-action/issues/101)
