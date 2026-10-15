# Testing Taxonomy

This page is the canonical test map for StructureClaw. It defines what each test category owns, which command runs it, and where CI workflows are allowed to overlap.

This document clarifies the current test system for issue #234 and is updated when workflow boundaries change.

## Category Definitions

| Category | Owns | Does not own | Primary command |
| --- | --- | --- | --- |
| Unit | Pure functions, small helpers, reducers, schema parsing, local component behavior | Process startup, real browser flows, real LLM calls | `npm test --prefix backend -- --runInBand` or `npm run test:run --prefix frontend` |
| Integration | One bounded subsystem with mocked or local dependencies, such as a route handler with service behavior or a rendered page with providers | Full install/startup, real external services, model-quality scoring | Backend Jest or frontend Vitest integration config |
| E2E | User-visible browser workflows against a running app | Deterministic engineering regression, deep backend contracts, LLM quality benchmarks | `npm run test:e2e --prefix frontend` |
| Regression | Deterministic behavior that must not drift across changes, especially engineering analysis and backend contract bundles | Exploratory browser checks, real model quality | `node tests/runner.mjs backend-regression` or `node tests/runner.mjs analysis-regression` |
| Validation | Named contract and schema checks that can be selected individually | Broad build/lint/test bundles | `node tests/runner.mjs validate <name>` |
| Smoke | Install, setup, build, and lifecycle compatibility checks on supported platforms | Owning unit, integration, or E2E coverage | `node tests/runner.mjs smoke-native` |
| LLM integration | Legacy real-LLM and routing integration checks | Long-term agent quality scoring | `node tests/runner.mjs llm-integration` |
| LLM benchmark | Real LangGraph agent quality checks with scenario scoring | Fast deterministic unit or contract coverage | `node tests/runner.mjs llm-benchmark` |

## Test Ownership

| Location | Category owner | Runner |
| --- | --- | --- |
| `backend/tests/*.test.mjs` | Backend unit or backend integration, depending on fixture scope | `npm test --prefix backend -- --runInBand` |
| `backend/src/**/__tests__/*.test.mjs` | Backend unit or focused subsystem integration | `npm test --prefix backend -- --runInBand` |
| `backend/src/agent-skills/**/__tests__/*` | Skill unit, handler, or skill integration coverage | `npm test --prefix backend -- --runInBand` or skill-specific npm scripts |
| `frontend/tests/*.test.ts(x)` plus `frontend/tests/lib/**`, `frontend/tests/stores/**`, and non-console `frontend/tests/components/**` | Frontend unit and configuration coverage | `npm run test:run --prefix frontend` |
| `frontend/tests/components/console/**` | Frontend integration coverage for the composed AI console, capability hydration, streamed responses, and provider-backed interactions | `npm run test:run:integration --prefix frontend` |
| `frontend/tests/accessibility/semantic.test.tsx` | Semantic/accessibility integration smoke for the composed console page | `npm run test:run:integration --prefix frontend` |
| `frontend/tests/integration/**` | Frontend integration coverage for pages, providers, and route groups | `npm run test:run:integration --prefix frontend` |
| `frontend/tests/e2e/**` | Playwright browser E2E coverage | `npm run test:e2e --prefix frontend` |
| `tests/regression/backend-validations.js` | Named validation contracts | `node tests/runner.mjs validate <name>` |
| `tests/regression/backend-regression.js` | Backend regression bundle | `node tests/runner.mjs backend-regression` |
| `tests/regression/analysis-runner.py` | Analysis regression fixtures | `node tests/runner.mjs analysis-regression` |
| `tests/smoke/**` | Native install and build smoke checks | `node tests/runner.mjs smoke-native` |
| `tests/llm-integration/**` | Legacy LLM integration harness and helper unit tests | `node tests/runner.mjs llm-integration` plus local helper tests |
| `tests/llm-benchmark/**` | LangGraph agent benchmark scenarios and scoring (git submodule from [structureclaw-benchmark](https://github.com/structureclaw/structureclaw-benchmark)) | `node tests/runner.mjs llm-benchmark` |

The public benchmark submodule contains the versioned corpus, frozen ground
truth, runner, and scoring runtime required for reproducible evaluation.

The OpenClaw external harness reuses that corpus and scorer:

```bash
node tests/runner.mjs openclaw-benchmark --dry-run
node tests/runner.mjs openclaw-benchmark --scenario <id> --mode all
```

It pins OpenClaw to `2026.6.33` and Paratera `GLM-5.2` (experiment label
`glm-5.2-paratera`) without model fallbacks. The
default workload concurrency is 10, while OpenSees, PKPM, and YJK each retain
an independent capacity-one solver lock; YJK also retains the 5-second
post-run cooldown. Standard workflow scenarios run in `auto` and
`generic-only`; interactive and multimodal scenarios run in `auto`.

## CI Workflow Boundaries

| Workflow | Purpose | Notes |
| --- | --- | --- |
| `.github/workflows/backend-regression.yml` | Backend regression on Linux and Windows | Runs the backend regression bundle through `tests/runner.mjs`. |
| `.github/workflows/frontend-regression.yml` | Frontend static and unit regression on Linux and Windows | Runs frontend type-check, lint, and unit Vitest coverage. |
| `.github/workflows/analysis-regression.yml` | Deterministic analysis regression on Linux and Windows | Builds the backend, sets up analysis Python, and runs analysis fixtures. |
| `.github/workflows/e2e.yml` | Isolated Playwright browser workflows without provider secrets | Triggered for relevant frontend and engineering changes on `master` and `work/research-next`, manually, or by `/test-e2e` comments from allowed users. |
| `.github/workflows/install-smoke.yml` | Native install/build compatibility smoke | Calls `node tests/runner.mjs smoke-native`; frontend and backend static checks live in their own regression workflows. |
| `.github/workflows/llm-integration.yml` | Real LLM integration checks | Triggered on `master`, manually, or by `/test-llm` comments from allowed users. |
| `.github/workflows/llm-benchmark.yml` | Trusted real-LLM benchmark checks | Uses the public benchmark runner and corpus. |
| `.github/workflows/publish-npm.yml` | Release gate before publishing | Repeats selected checks to protect releases. It does not own new coverage. |

## Frontend Vitest Split

The frontend has two Vitest configs with mutually exclusive ownership:

- `frontend/vitest.config.ts` owns fast unit/configuration coverage and explicitly excludes `tests/integration/**`, `tests/components/console/**`, `tests/accessibility/**`, and `tests/e2e/**`.
- `frontend/vitest.integration.config.ts` owns app-route/provider/console integration coverage and includes `tests/integration/**/*.test.tsx`, `tests/components/console/**/*.test.tsx`, and `tests/accessibility/semantic.test.tsx`.
- New console shell tests, provider-backed page tests, or tests that need the integration backend fixture should go into the integration runner even if they render React components.

## Isolated Browser E2E

Build with `node sclaw build`, install the matching browser with `npm exec --prefix frontend -- playwright install chromium`, then run `npm run test:e2e --prefix frontend`. Playwright starts the real backend and an immutable copy of the exported frontend on `127.0.0.1:31515`, with a fresh SQLite database and settings under `.tmp/playwright-*`. It never reuses the normal application ports or imports personal LLM credentials. Test artifacts remain under `frontend/test-results` and `frontend/playwright-report`.

The startup helper requires a Python runtime that can import FastAPI and OpenSeesPy. Set `SCLAW_E2E_PYTHON` explicitly when the configured installation is elsewhere. `SCLAW_E2E_PORT` selects another isolated port; ports 31415 and 31416 are rejected. `SCLAW_E2E_ATTACH=1` attaches only to an instance created by `frontend/tests/e2e/start-server.mjs`, verified using its runtime identity and database path. Do not run separate test commands concurrently against one instance: settings tests and local LLM fixtures share that instance's configuration.

Startup strictly checks the frontend build fingerprint. The backend currently has only a source timestamp check, which cannot detect deletions or edits with preserved timestamps; it does not replace the full build step above.

Default browser tests use local scripted LLM responses for orchestration checks, while the application, model transactions, OpenSees, result queries and report services execute normally. These scripts prove product behavior, not model quality. Paid live smoke tests require `SCLAW_E2E_LIVE=1` and a separately started isolated instance whose LLM settings were explicitly configured through its own settings page or API. A provider key in the shell alone does not enable live tests. Live smoke checks delivery and visible failures; it is not benchmark scoring.

For live smoke, set `SCLAW_E2E_ATTACH=1` and the matching port, then run `npm run test:e2e --prefix frontend -- structural-analysis.spec.ts`. Live mode allows `structural-analysis.spec.ts` and `live-run-settings.spec.ts`; scripted LLM fixtures refuse to modify settings in this mode. Real calls consume the configured provider's allowance; failed live tests are not automatically retried.

The deterministic engineering workflow covers real OpenSees execution, agreement between selected-position queries/reports/figures, JSON export, reload, edit invalidation, history and undo/recalculation. Bilingual browser controls verify actual guidance, context, memory permission, correction, clarification/resume and tool-budget behavior. Browser assertions cover builder/fixed-routing control transmission; the corresponding runtime regressions own execution-branch coverage. These are not model-answer quality tests.

### Manual live beam replay

For a reviewed, multi-turn reproduction with a real provider and real solver, use `frontend/tests/e2e/manual/live-beam-browser.cjs`. Build first, start `frontend/tests/e2e/start-server.mjs` on a dedicated `SCLAW_E2E_PORT`, and configure the LLM through that isolated instance's settings UI or API. The probe verifies its server receipt, instance ID and database path; it rejects normal product ports and scripted/unconfigured model identities. It never updates provider settings or copies credentials.

Copy `frontend/tests/e2e/manual/beam-design.example.json` outside tracked files to set the matching port, locale (`en` or `zh`), original prompt, requested controls and evidence directory. Run the command without `--run` to prepare the browser; explicitly add `--run` to send real requests:

```bash
node frontend/tests/e2e/manual/live-beam-browser.cjs --config=.tmp/live-beam.json --run
```

After each response, inspect the actual question and saved tool trace. Write `{"text":"your reviewed clarification"}` to the `reply-N.json` path printed in `pending-reply.json`; only then does the browser send the next message. Use `{"finish":true}` to finish. The example never preselects an answer or invents material, section or design conditions. User-supplied test assumptions must be identified as such. Optional `expectedAnalysis.metrics` and `absoluteTolerance` compare actual analysis summaries against independently supplied reference values; those values are not sent to the agent.

Each attempt uses a new browser context and timestamped evidence directory. Conversations, sessions, streamed events, analysis runs, tool messages, screenshots, a Playwright trace and browser errors are retained, including failed attempts. Completion requires current analysis/report evidence and, when requested, a complete passing code check; clarification alone is incomplete. There are no automatic retries. This is live product workflow acceptance, not a Bench accuracy result. Avoid rebuilding or restarting the tested backend during a turn.

`beam-hw-reproduction-20261015.json` retains the short beam request and the reported Q235B / HW300×300×10×15 selection. Review clarification answers before sending them; checking only an already completed I20a model does not cover this input path. Section kind casing is canonicalized from the V2 vocabulary, while dimensions, properties, source conflicts and missing design conditions remain subject to validation. Four explicit H/HW/HM/HN dimensions describe sharp-corner geometry, not a verified rolled-section catalog row.

For deterministic coverage, run `node backend/tests/section-shape-acceptance.mjs` with an isolated `SCLAW_DATA_DIR` whose settings specify the installed analysis Python. It freezes analytical references before building, then uses registered tools and real OpenSees for eight section representations, checks queried displacement/rotation and bilingual report values, and verifies that absent design conditions cannot yield a passing check. A ninth case replays the saved draft with supplied design conditions and stale nested design diagnostics, requiring all 14 checks to pass without rewriting its history. No LLM key or Bench files are needed. The Jest analysis-control clarification regression separately checks that explicit `false` answers clear missing-input markers without clearing source conflicts.

Optional `expectedModelValues` asserts facts directly from the persisted `/agent/input-review` model, without sending them to chat. Each rule uses a dot-separated `path` and `value`; add `collection` with an optional `id` or `where` filter to inspect records. For example, `{"collection":"elements","where":{"type":"beam"},"path":"design.l0","value":4800}` checks every beam, regardless of its ID, and fails if no beam exists. Use `minMatches` to require multiple matches and `absoluteTolerance` for numeric comparisons. Missing or unequal values make `summary.pass` false even if the report says the design passed. Only configure facts explicitly supplied for that attempt; retain the original failing evidence.


## Choosing A Test

Use the smallest category that proves the behavior:

- Backend logic or route behavior: add or run targeted Jest tests, then run `node tests/runner.mjs backend-regression` if contracts can be affected.
- Frontend component or state behavior: add or run Vitest tests, plus `npm run type-check --prefix frontend`. Use the integration Vitest runner for console shell, provider-backed page, route, or accessibility coverage.
- Browser behavior across pages: use Playwright E2E.
- Engineering analysis output, converter behavior, schema contracts, or agent orchestration payloads: use named validations or analysis regression.
- CLI setup, install, build, and platform compatibility: use smoke tests.
- Real LLM agent quality: use the LLM benchmark path. Keep model-quality assertions out of deterministic unit and E2E tests.

## Overlap Policy

- Each test file should have one category owner and one primary runner.
- CI workflows may call bundles for gating, but a duplicated command in CI does not transfer ownership.
- Release and smoke workflows may repeat build, lint, or test commands as compatibility gates. Do not add new category-specific assertions there unless the workflow itself is the target.
- Do not use E2E tests to cover deterministic backend contracts or engineering fixtures.
- Do not use unit, validation, or E2E tests to judge real LLM answer quality. Use `tests/llm-benchmark/**`.
- When adding coverage for follow-up test issues, place the new test under the owning category first, then only wire CI if that category is missing from CI.

## Current Gaps Made Explicit

- E2E covers navigation, i18n/theme, capabilities, database admin, run controls and browser delivery using real engineering services. Live model calls run separately on demand; this is not a full agent quality suite.
- Frontend integration tests have a dedicated local command, but are not wired into CI until the integration runner is stable.
- `install-smoke.yml` now owns native install/build compatibility only.
- `llm-integration` and `llm-benchmark` both touch real LLM behavior today. New agent-quality scenarios should prefer the benchmark path.
- Issue #234 should settle boundaries and documentation first. Separate coverage-expansion issues should add the missing tests.
