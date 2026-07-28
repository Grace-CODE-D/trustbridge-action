# Contributing to TrustBridge Action

Thank you for helping improve **trustbridge-action**! This guide covers local setup, coding standards, and the pull request process.

Related docs: [README](README.md) · [Structure](docs/STRUCTURE.md) · [Architecture](docs/ARCHITECTURE.md)

---

## Code of conduct

Be respectful and constructive. We follow standard open-source community norms: welcome newcomers, assume good intent, and focus feedback on the work.

---

## Ways to contribute

- **Bug reports** — Horizon edge cases, comment formatting, GitHub API quirks
- **Features** — multi-asset checks, PR comments, improved address extraction examples
- **Documentation** — clearer remediation text, translations, workflow recipes
- **Tests** — expand coverage for `horizon.ts` with mocked fetch

---

## Local development

### Requirements

- Node.js **20+**
- npm **9+**

### Setup

```bash
git clone https://github.com/Stellar-TrustBridge/trustbridge-action.git
cd trustbridge-action
npm ci
```

### Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run Jest unit tests |
| `npm run test:coverage` | Coverage report in `coverage/` |
| `npm run test:mock` | Smoke tests against local mock Horizon (requires `npm run mock:start` first) |
| `npm run lint` | ESLint on `src/` and `__tests__/` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run mock:start` | Start mock Horizon container on `http://localhost:8089` |
| `npm run mock:stop` | Stop and remove mock Horizon container |

All commands except `mock:*` and `test:mock` must pass before opening a PR. CI runs the same pipeline (see `.github/workflows/ci.yml`).

---

## Mock Horizon for local development

TrustBridge ships a [WireMock](https://wiremock.org)-based mock Horizon server
so contributors can develop and test the action offline without hitting public
Horizon or consuming rate-limit quota.

### Quick start

```bash
# Requires Docker Desktop (or Docker Engine + Compose v2)
npm run mock:start                                # start on http://localhost:8089
HORIZON_MOCK_URL=http://localhost:8089 npm run test:mock   # run smoke tests
npm run mock:stop                                 # stop container
```

### What is mocked

| Scenario | Address | Response |
|----------|---------|----------|
| All checks pass | `GAAA...AWHF` | 200, 10 XLM, USDC trustline |
| Unfunded account | `GBBB...BBBB` | 404 Not Found |
| Low XLM balance | `GCCC...CCCC` | 200, 0.5 XLM, USDC trustline |
| No trustline | `GDDD...DDDD` | 200, 10 XLM, no trustline |
| Rate limited | `GEEE...EEEE` | 429 with `Retry-After: 1` |

Stub definitions live in `mock/horizon/mappings/`. Full documentation:
[mock/horizon/README.md](mock/horizon/README.md).

### Skip behaviour

The smoke test file (`__tests__/horizon-mock-smoke.test.ts`) skips all suites
automatically when `HORIZON_MOCK_URL` is not set — so `npm test` is never
affected by whether Docker is running.

---

## Project conventions

### TypeScript

- Strict mode enabled (`tsconfig.json`)
- Prefer pure functions in `checks.ts` — no I/O
- HTTP and GitHub API code stay in `horizon.ts` and `comment.ts`
- Use explicit types for Horizon responses

### Module boundaries

```
index.ts     → orchestration only
horizon.ts   → Horizon HTTP + types
checks.ts    → validation (unit tested)
comment.ts   → Markdown + Octokit
```

Do not import `@actions/github` outside `comment.ts` / `index.ts`.

### Testing

- Add tests in `__tests__/` for validation logic changes
- Mock external HTTP; avoid live Horizon calls in CI
- Name tests after behavior: `fails when XLM balance is below minimum reserve`

### Comments and docs

- Update [README.md](README.md) for user-facing input/output changes
- Update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design changes
- Update [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md) for new failure modes
- Cross-link new docs from README “Documentation index”

---

## Pull request process

1. **Fork** the repository and create a feature branch from `main`
2. **Implement** your change with tests where applicable
3. **Run** `npm run lint && npm test && npm run build`
4. **Open a PR** with:
   - Clear title (e.g. `fix: retry Horizon 504 with longer backoff`)
   - Summary of what and why
   - Test plan checklist
   - Links to related issues

### PR checklist

- [ ] Tests pass locally (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] `dist/` updated if runtime code changed (commit compiled output for releases)
- [ ] README / docs updated if behavior or inputs changed
- [ ] No secrets or real contributor addresses in commits

---

## Commit messages

Use concise, imperative subjects:

```
feat: add testnet defaults example workflow
fix: honor Retry-After on Horizon 429
docs: clarify fail_on_missing in USAGE guide
test: cover zero-trustline account path
```

---

## Releasing (maintainers)

1. Merge to `main` with passing CI
2. Tag semver (`v1.0.1`)
3. Create GitHub Release with changelog
4. Consumers pin `@v1` or specific patch tag

**Build note:** `npm run build` runs TypeScript checking and `@vercel/ncc` to bundle `dist/index.js`. Commit `dist/` when releasing.

---

## Security

- **Do not** commit API keys, tokens, or `.env` files
- Report security issues privately to repository maintainers before public disclosure

---

## Questions

Open a [GitHub Discussion](https://github.com/Stellar-TrustBridge/trustbridge-action/discussions) or issue if setup steps are unclear — improvements to this doc are welcome too.

---

[← Back to README](README.md)
