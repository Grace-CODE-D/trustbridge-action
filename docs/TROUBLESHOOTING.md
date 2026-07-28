# Troubleshooting

## No issue comment appears

Confirm the action ran on an `issues` event and the workflow permissions include `issues: write`. Workflow dispatch runs can still validate, but there may be no issue context to comment on.

## Account is reported unfunded

Horizon returns `404` for accounts that have not been activated. Send the account at least the Stellar minimum balance before adding trustlines.

## Trustline is missing

Check both the asset code and issuer. A USDC trustline for a different issuer is not considered ready.

## XLM reserve too low

The account exists but its native XLM balance is below `min_xlm_reserve`. Send additional XLM so the balance meets the configured minimum (default `1.5` XLM). Remember that each trustline also consumes base reserve.

## Horizon availability failed

Retry later or switch `horizon_url` to a trusted endpoint for the target network.
