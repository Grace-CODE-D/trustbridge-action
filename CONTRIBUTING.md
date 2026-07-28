# Contributing to TrustBridge Action

Thank you for helping improve **trustbridge-action**! This guide covers local setup, coding standards, and the pull request process.

Related docs: [README](README.md) · [Structure](docs/STRUCTURE.md) · [Architecture](docs/ARCHITECTURE.md) · [Breaking Changes](docs/BREAKING_CHANGES.md) · [License Report](docs/LICENSE_REPORT.md)

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
| `npm run lint` | ESLint on `src/` and `__tests__/` |
| `npm run build` | Compile TypeScript to `dist/` |

All commands must pass before opening a PR. CI runs the same pipeline (see `.github/workflows/ci.yml`).

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
- [ ] `docs/BREAKING_CHANGES.md` consulted — change classified as breaking or non-breaking and version bump applied accordingly
- [ ] No secrets or real contributor addresses in commits
- [ ] If a new **runtime** dependency was added to `dependencies` (not `devDependencies`), its SPDX license identifier has been checked against the compatibility table in [docs/LICENSE_REPORT.md](docs/LICENSE_REPORT.md)

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
2. Consult [docs/BREAKING_CHANGES.md](docs/BREAKING_CHANGES.md) — determine whether the release is a patch, minor, or major bump
3. Tag semver (`v1.0.1`)
4. Move the major tag (`v1`) to the new commit **only** if the release is on the same major line; create a new tag (`v2`) for a breaking release
5. Create GitHub Release with changelog — note any input/output changes and link to `docs/BREAKING_CHANGES.md` if inputs or outputs changed
6. Consumers pin `@v1` or specific patch tag

**Build note:** `npm run build` runs TypeScript checking and `@vercel/ncc` to bundle `dist/index.js`. Commit `dist/` when releasing.

---

## Security

- **Do not** commit API keys, tokens, or `.env` files
- Report security issues privately to repository maintainers before public disclosure

### Validation performance budget

CI includes a deterministic performance budget test (`__tests__/validation.performance.test.ts`) that times a full validation run of the action handler (`run` in `src/index.ts`) with **mocked Horizon** (no live network).

| Setting | Value |
|---------|--------|
| Metric | p95 wall-clock duration over 25 samples (after warmup) |
| Budget | **2000 ms** (`VALIDATION_PERFORMANCE_BUDGET_P95_MS`) |
| Why generous | Standard GitHub-hosted runners vary; headroom avoids flakes |

The test fails when p95 exceeds the budget. Failure messages call out likely causes: **Horizon retries**, **extra fetches**, or **logging/metrics bloat** on the validation path.

#### Updating the baseline intentionally

1. Confirm the slowdown is expected (new required work, not an accidental regression).
2. Change `VALIDATION_PERFORMANCE_BUDGET_P95_MS` in `__tests__/validation.performance.test.ts`.
3. Update the budget value in this section to match.
4. Explain the new baseline in the PR description.

Do not raise the budget to silence an unexplained regression.

---

## License compliance

TrustBridge Action is published under the **MIT License**. All runtime dependencies (packages in `dependencies`, not `devDependencies`) must carry a compatible license.

**Safe to add:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0.

**Requires maintainer review:** LGPL-2.1, LGPL-3.0, MPL-2.0.

**Do not add without explicit approval:** GPL-2.0, GPL-3.0, AGPL-3.0, SSPL-1.0, BUSL-1.1, or any `UNLICENSED`/`UNKNOWN` package.

The full compatibility table, the local generation command (`npm run license:report`), and instructions for finding the report in GitHub Release assets are documented in [docs/LICENSE_REPORT.md](docs/LICENSE_REPORT.md).

A license report (`licenses-report.json` + `licenses-report.md`) is generated automatically by the release workflow and attached to every GitHub Release — no manual step is needed.

---

## Questions

Open a [GitHub Discussion](https://github.com/Stellar-TrustBridge/trustbridge-action/discussions) or issue if setup steps are unclear — improvements to this doc are welcome too.

---

[← Back to README](README.md)
