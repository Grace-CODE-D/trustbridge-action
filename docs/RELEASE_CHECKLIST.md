# Release Checklist

Use this lightweight checklist before tagging a new action release.

## Verify

- Run the unit test suite (`npm test`).
- Run test coverage and verify comment golden snapshots and Jest coverage gate pass (`npm run test:coverage`).
- Run linting (`npm run lint`).
- Run the build so `dist/` matches `src/` (`npm run build`). CI fails the build if `dist/` drifts from a fresh `npm run build` (see `.github/workflows/ci.yml`), but re-run it locally before tagging to be sure.
- Confirm `action.yml` inputs and README inputs stay aligned.
- Confirm the release workflow still passes on the tag you plan to ship. The repo-level release job is a dry run gate for `v*` tags and should stay green before moving a major tag.
- Keep an eye on XLM fee buffer guidance in the docs if the validation defaults change; the release checklist should point maintainers back to the current remediation copy.

## Tagging

- Create a semantic tag such as `v1.0.1`.
- Move the major tag, such as `v1`, only after the release is verified.
- Include one short note about any behavior or input changes.
