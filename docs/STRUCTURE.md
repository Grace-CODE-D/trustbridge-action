# Project structure

File and directory reference for **trustbridge-action**. For design rationale see [Architecture](ARCHITECTURE.md); for usage see [Usage](USAGE.md).

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Contributing](../CONTRIBUTING.md)

---

## Tree overview

```
trustbridge-action/
├── .github/
│   └── workflows/
│       └── ci.yml                 # Lint, test, build on push/PR
├── __tests__/
│   └── checks.test.ts             # Unit tests for validation logic
├── docs/
│   ├── ARCHITECTURE.md            # System design
│   ├── ERROR_HANDLING.md          # Failure modes and retries
│   ├── STRUCTURE.md               # This file
│   └── USAGE.md                   # Workflow examples
├── src/
│   ├── index.ts                   # Action entrypoint
│   ├── horizon.ts                 # Horizon API client
│   ├── checks.ts                  # Validation rules
│   └── comment.ts                 # GitHub comment builder
├── action.yml                     # GitHub Action manifest
├── CONTRIBUTING.md                # Contribution guide
├── eslint.config.mjs              # ESLint flat config
├── jest.config.js                 # Jest + ts-jest
├── LICENSE                        # MIT
├── package.json                   # Dependencies and scripts
├── package-lock.json              # Lockfile (generated)
├── README.md                      # Project overview
└── tsconfig.json                  # TypeScript compiler options
```

Generated / ignored (not committed):

```
dist/                              # Compiled JavaScript (build output)
node_modules/                      # npm dependencies
coverage/                          # Jest coverage reports
```

---

## Root files

| File | Purpose |
|------|---------|
| `action.yml` | Declares action name, inputs, outputs, and `runs.main` entry (`dist/index.js`) |
| `package.json` | npm metadata, scripts (`build`, `test`, `lint`), runtime and dev dependencies |
| `tsconfig.json` | `target: ES2020`, `module: commonjs`, `outDir: dist`, `rootDir: src` |
| `jest.config.js` | Runs tests in `__tests__/` via ts-jest |
| `eslint.config.mjs` | TypeScript-aware lint rules for `src/` and `__tests__/` |
| `LICENSE` | MIT license |
| `README.md` | Primary documentation entry point |
| `CONTRIBUTING.md` | Contributor workflow and standards |

---

## Source modules (`src/`)

### `index.ts`

**Role:** Orchestrator — the only file executed at runtime.

**Flow:**

1. Parse and validate inputs via `@actions/core`
2. Call `fetchAccount` or catch `HorizonError`
3. Delegate to `runAccountChecks`, `unfundedAccountResult`, or `horizonFailureResult`
4. Set outputs
5. Post comment via `postIssueComment`
6. `setFailed` or `warning` based on `fail_on_missing`

**Dependencies:** `checks.ts`, `horizon.ts`, `comment.ts`, `@actions/core`, `@actions/github`

---

### `horizon.ts`

**Role:** Stellar Horizon HTTP layer.

**Exports:**

| Export | Description |
|--------|-------------|
| `HorizonAccount`, `HorizonBalance` | Response types |
| `HorizonError` | Typed error with `statusCode` and `retryable` |
| `fetchAccount` | GET account with timeout and retries |
| `getNativeBalance` | Extract XLM balance string |
| `hasTrustline` | Match asset code + issuer in balances |

**Dependencies:** `node-fetch` (dynamic import)

---

### `checks.ts`

**Role:** Pure business logic — no GitHub or HTTP.

**Exports:**

| Export | Description |
|--------|-------------|
| `validateStellarAddress` | Throws on invalid G-address |
| `isValidStellarAddress` | Full StrKey validation (shape + version byte + CRC-16/XMODEM checksum) |
| `parseMinXlmReserve` | Parse and validate reserve input |
| `runAccountChecks` | Full validation for funded accounts |
| `unfundedAccountResult` | Result template for 404 |
| `horizonFailureResult` | Result template for API errors |
| `buildValidationGate` | Machine-readable pass/fail summary |
| `STELLAR_*_XLM` | Documented reserve constants |
| `checkTrustlineExists` | **(Wave #32)** Point check: trustline exists for asset |
| `checkReserveMet` | **(Wave #32)** Point check: XLM balance ≥ min reserve |
| `validateStrKeyFormat` | **(Wave #32)** StrKey shape validation (G- and C-addresses) |
| `checkMultiAssetTrustlines` | **(Wave #32)** Batch trustline check for multiple assets |
| `calculateRecommendedReserve` | **(Wave #32)** Stellar reserve formula by trustline count |
| `checkAccountSponsored` | **(Wave #32)** True if account has `num_sponsored > 0` |
| `generateValidationReport` | **(Wave #32)** Full structured `ValidationReport` for dashboards |

**Test coverage:** `__tests__/checks.test.ts`, `__tests__/reusable-workflows.test.ts`

---

### `comment.ts`

**Role:** User-facing Markdown and GitHub API.

**Exports:**

| Export | Description |
|--------|-------------|
| `formatCommentBody` | Build full comment from `ValidationResult` |
| `postIssueComment` | Octokit `issues.createComment` |

**Dependencies:** `@actions/core`, `@actions/github`, types from `checks.ts`

---

## Tests (`__tests__/`)

| File | Scope |
|------|-------|
| `assets.test.ts` | Asset code normalisation and config helpers |
| `checks.test.ts` | Address validation, trustline matching, reserve checks, unfunded results |
| `comment.test.ts` | Markdown formatting and golden snapshot enforcement |
| `configReader.test.ts` | YAML parsing, SSRF blocking, injection sanitisation, merge precedence |
| `e2e-parser-harness.test.ts` | **Wave #39** — full pipeline e2e tests via jest.fn() HTTP mocks: success, 404, 503, 429-retry, malformed responses, comment snapshots, 100-contributor scale |
| `hardened_metrics.test.ts` | Metrics collector hardening |
| `horizon.test.ts` | Horizon client: fetch, retries, cache, RPC fallback, debug log redaction |
| `inputs.test.ts` | `parseBooleanInput`, `parseNumberInput`, `getErrorMessage` |
| `links.test.ts` | Stellar Laboratory and LOBSTR link builders |
| `logger.test.ts` | StructuredLogger, redaction helpers |
| `markdown.test.ts` | `escapeMarkdownInline`, `inlineCode` |
| `metrics.test.ts` | MetricsCollector |
| `outputs.test.ts` | `setValidationOutputs` |
| `parser-fuzz.test.ts` | **Wave #39** — property/fuzz tests across all parser functions with malicious inputs, boundary cases, and performance benchmarks |
| `resilience.test.ts` | Backoff, jitter, RateLimiter, CircuitBreaker, runCliCheck |
| `reusable-workflows.test.ts` | **Wave #32** — unit and integration tests for workflow helpers: `checkTrustlineExists`, `checkReserveMet`, `validateStrKeyFormat`, `checkMultiAssetTrustlines`, `calculateRecommendedReserve`, `checkAccountSponsored`, `generateValidationReport` |
| `sep0007.test.ts` | SEP-0007 wallet deep link generation |
| `spans.test.ts` | OTel-style validation spans |
| `summary.test.ts` | `formatFailureSummary` |
| `validation.test.ts` | `validateContractAddress`, `validateAssetCode`, SSRF/injection validators |
| `workflow.test.ts` | CI workflow YAML sanity checks |

Horizon HTTP is not integration-tested in CI (no live network calls). Retry behavior is covered in `horizon.test.ts` via jest.fn() mocks. The Wave #39 e2e harness (`e2e-parser-harness.test.ts`) exercises the full parser → validation → comment pipeline through mocked Horizon responses.

---

## CI (`.github/workflows/`)

| Workflow | Trigger | Steps |
|----------|---------|-------|
| `ci.yml` | push/PR to main, `workflow_dispatch` | checkout → Node 20 → `npm ci` → lint → test → build → verify `dist/index.js` |

---

## Documentation (`docs/`)

| Doc | Audience | Links from README |
|-----|----------|-------------------|
| `ARCHITECTURE.md` | Maintainers, reviewers | “How it works” |
| `STRUCTURE.md` | New contributors | “Repository layout” |
| `USAGE.md` | Action consumers | “Quick start”, inputs |
| `ERROR_HANDLING.md` | Operators debugging failures | “Error handling” |

All docs cross-link to `README.md` and `CONTRIBUTING.md`.

---

## npm scripts

| Script | Command | When to use |
|--------|---------|-------------|
| `build` | `tsc` | Before commit / release; produces `dist/` |
| `test` | `jest` | Local verification and CI |
| `test:coverage` | `jest --coverage` | Coverage reports |
| `lint` | `eslint src __tests__ --ext .ts` | CI and pre-PR |
| `prepare` | `npm run build` | Runs on `npm install` (ensures `dist/` exists) |

---

## Release artifact

Published action consumers need:

1. `action.yml`
2. `dist/index.js` (+ `.map` optional)
3. `package.json` (for metadata; runtime deps bundled in dist if using ncc in future)

Current build uses `@vercel/ncc` to produce a single bundled `dist/index.js` for GitHub Actions runtime. Run `npm run build` before release and commit `dist/`.

---

[← Back to README](../README.md)
