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

- Node.js **20 LTS or 22 LTS** (both are tested in CI — see `.github/workflows/ci.yml`)
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

### Release checklist

Before cutting a release tag, ensure:

1. **All CI checks pass** — Push to a feature branch and verify CI passes completely
2. **Run coverage gates** — `npm run test:coverage` must pass (statement/branch/function/line thresholds)
3. **Build and verify dist/** — Run `npm run build` and commit the rebuilt `dist/`
4. **dist/ matches src/** — After any code change, `dist/` must be up-to-date. CI enforces this via `git diff --exit-code -- dist`
5. **Update action.yml if inputs/outputs changed** — Ensure new or changed inputs have descriptions and defaults
6. **Update docs** — If behavior or inputs changed, update [docs/USAGE.md](docs/USAGE.md) and [README.md](README.md)
7. **Smoke test via SHA reference** — Clone a fresh copy of the repository and test the action by SHA to ensure the bundled dist/ works as a GitHub Action
8. **Prepare SBOM** — If releasing with Issue #69 (SBOM attachment), generate the SBOM before tagging
9. **Create GitHub Release** — Once the tag is pushed, create a Release page with a changelog (use `v1.0.0` format for tag names)

### Packaging essentials

**Why packaging matters:**
- Consumers pin the action by SHA (`@<commit>`) or tag (`@v1`). Missing or stale `dist/` silently breaks comment posting.
- GitHub Actions require `dist/index.js` to exist; missing it causes "action not found" errors.
- `ncc` bundles dependencies so Node.js isn't required at runtime; if `dist/` isn't committed, the compiled code won't be available to runners.

**Build process:**
```bash
npm run build
# Outputs: dist/index.js, dist/index.js.map, dist/licenses.txt
```

This step:
1. Runs `tsc --noEmit` to typecheck (fails if there are errors)
2. Runs `@vercel/ncc` to bundle all dependencies into a single `dist/index.js`
3. Generates source maps for debugging
4. Extracts license information

**CI enforcement:**
- `.github/workflows/ci.yml` runs `npm run build` and verifies `dist/index.js` exists
- It also runs `git diff --exit-code -- dist/` to fail if committed `dist/` is stale relative to src/

**Manual smoke test:**
```bash
# In a fresh clone of the release tag:
git checkout v1.0.0
ls -la dist/index.js  # Must exist
node dist/index.js    # Should not throw (though it needs GitHub env to run fully)
```

### Release and SBOM workflow

Once packaging is complete and tagged:

1. **Push tag to repository** — `git push origin v1.0.0`
2. **Wait for release workflow** — `.github/workflows/release.yml` runs `verify-release` job on the tag
3. **Generate SBOM** (if using Issue #69) — The release workflow can generate and attach an SBOM asset
4. **Create GitHub Release** — Link to the tag, add changelog, attach SBOM if generated

---

## Semver guidance

- **MAJOR** (v2.0.0) — Breaking changes to inputs, outputs, or behavior; major feature additions
- **MINOR** (v1.1.0) — New non-breaking features, new locales, new output formats
- **PATCH** (v1.0.1) — Bug fixes, dependency updates, documentation improvements

**`runs.using` note:** `action.yml` currently specifies `runs.using: node20`. Bumping this to `node22` requires waiting for GitHub Actions to ship an official `node22` label — this is deferred to a future major/minor release. Node 22 compatibility is already verified in the CI matrix.

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
