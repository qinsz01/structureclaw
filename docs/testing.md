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
| Architecture | Layer boundaries and file-level import cycles in `backend/src` | Runtime behaviour | `npm run check:deps --prefix backend` |
| Python | `test_*.py` modules under `backend/src` and `backend/tests` | Node/Jest contracts | `npm run test:python --prefix backend` |
| Characterization | Scripted-LLM end-to-end agent behaviour pinned by snapshots (`backend/tests/characterization`) | Real LLM quality, Bench scoring | `npm run test:characterization --prefix backend` |

## Test Ownership

| Location | Category owner | Runner |
| --- | --- | --- |
| `backend/tests/*.test.mjs` | Backend unit or backend integration, depending on fixture scope | `npm test --prefix backend -- --runInBand` |
| `backend/tests/dist-surface.test.mjs` | Compiled `backend/dist` surface consumed by code outside `backend/src` | `npm test --prefix backend -- --runInBand` |
| `backend/tests/characterization/**` | Backend characterization: scripted-LLM agent behaviour and snapshot-pinned contracts | `npm run test:characterization --prefix backend` |
| `backend/src/**/test_*.py`, `backend/tests/test_*.py` | Backend Python tests | `npm run test:python --prefix backend` |
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

## Backend Layering, Python, Characterization And Compiled-Surface Gates

These backend gates run from the repository root with `--prefix backend`.

| Command | Owns | Notes |
| --- | --- | --- |
| `npm run check:deps --prefix backend` | Import layering and file-level import cycles in `backend/src` | Runs dependency-cruiser with `backend/.dependency-cruiser.cjs`. Layers run from L0 (`shared/`, `types/`) to L6 (`api/`, `index.ts`); lower layers never import higher ones. The config lists the two allowed exceptions: the `runtime/policy-settings.ts` shim and the structure-type/section handler SDK edges. |
| `npm run test:python --prefix backend` | Every `test_*.py` under `backend/src` and `backend/tests`, as selected by `backend/pytest.ini` | Runs `pytest` with the first interpreter that can import it: `PYTHON_FOR_TEST`, `backend/.venv`, `<SCLAW_DATA_DIR or ~/.structureclaw>/.venv`, then the platform launcher order (`py`, `python3`, `python`). Arguments after `--` go to pytest, e.g. `-- -k native_design`. |
| `npm run test:characterization --prefix backend` | Scripted-LLM end-to-end characterization in `backend/tests/characterization` | Builds the backend, then runs Jest on that folder. Each scenario drives the real LangGraph agent, tools and run policy with a scripted LLM (`helpers/llm-fixture.mjs`). Snapshots in `__snapshots__/` pin tool exposure, system prompts, the default `policyHash`, draft paths, edit invalidation, clarification resume and ablation profiles. OpenSees-backed cases are skipped with a warning when no Python with OpenSees is found; set `SCLAW_TEST_PYTHON` to choose one. |
| `npm run test:live --prefix backend -- --base-url <url>` | LIVE acceptance (`backend/tests/live/one-sentence-beam.mjs`, `internal-forces.mjs`, shared `client.mjs`) against an already started backend and its configured LLM | Not part of Jest. The default `acceptance` variant runs: **beam** — zh/en "design a simply supported steel beam ... HN300×150×6.5×9" must finish in one turn with a current analysis and report and no `run_code_check`; reactions, midspan moment and deflection are compared with closed-form values (relative 1e-6); the follow-up "check against GB50017" must run the check without an interrupt, show f=305/fv=175 MPa with their GB 50017-2017 Table 4.4.1 source and list the lateral-stability and deflection inputs. **forces** — zh/en "compute the internal forces of a simply supported beam, span 10 m, 1 kN at midspan" must be answered with no question, no report, no code check and no displacement (reactions 0.5 kN, |M| 2.5 kN·m); the follow-up "那挠度呢 / And the deflection?" must ask for the material and section. **continuous** — a two-span 2×6 m beam, 10 kN/m, forces only: no question, the equal-EI assumption stated, support moment 45 kN·m, reactions 22.5/75/22.5 kN. Results report wall time, question count and tool sequence. Skips when the backend has no LLM API key. Options: `--locale zh|en|all`, `--runs N`, `--variant acceptance|beam|forces|continuous|portal|hn-no-thickness|original` (`portal`, `hn-no-thickness` and `original` are exploratory), `--out <dir>`. |
| `backend/tests/dist-surface.test.mjs` (also run by `npm test --prefix backend`) | The compiled `backend/dist` surface consumed from outside `backend/src` | Asserts that the modules and symbols used by `tests/llm-benchmark/runner.cjs`, `integrations/openclaw`, `tests/regression/backend-validations.js` and `scripts/verify-scenario-freeze.mjs` still import and export the expected names. It reads `dist/`, so build first. Moving such a module requires a re-export shim at the old path. |

`npm test --prefix backend` matches `tests/**/*.test.mjs`, so the characterization suite and the dist-surface test also run in the default Jest pass.

### Characterization Snapshot Policy

- Snapshots under `backend/tests/characterization/__snapshots__/` record the current agent behaviour. A failing snapshot is a finding to explain, not noise to clear.
- Update only for an intentional behaviour change: `npm run test:characterization --prefix backend -- -u`. Review the `.snap` diff line by line in the same change, and state the behavioural reason in the commit message.
- Do not update snapshots to make an unexplained failure pass, and do not update them in a change that is meant to preserve behaviour (for example a refactor). Such a diff is a regression until shown otherwise.


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

To explicitly continue an interrupted isolated conversation, set `resumeConversationId` and use `initialPrompt` for the reviewed next message. The probe selects the saved conversation through the UI, refuses a busy session and captures its state before continuing. Keep the preceding failed evidence alongside the continuation; a successful continuation is not an uninterrupted pass. Finish all validation commands that rebuild `dist` before starting parallel browser or subprocess tests.

`beam-hw-reproduction-20261015.json` retains the short beam request and the reported Q235B / HW300×300×10×15 selection. Review clarification answers before sending them; checking only an already completed I20a model does not cover this input path. Section kind casing is canonicalized from the V2 vocabulary, while dimensions, properties, source conflicts and missing design conditions remain subject to validation. Four explicit H/HW/HM/HN dimensions describe sharp-corner geometry, not a verified rolled-section catalog row.

For deterministic coverage, run `node backend/tests/section-shape-acceptance.mjs` with an isolated `SCLAW_DATA_DIR` whose settings specify the installed analysis Python. It freezes analytical references before building, then uses registered tools and real OpenSees for seven section representations (designations are labels; there is no section catalogue), checks queried displacement/rotation and bilingual report values, and verifies that absent design conditions cannot yield a passing check. An eighth case replays the saved draft with supplied design conditions and stale nested design diagnostics, requiring all 14 checks to pass without rewriting its history. No LLM key or Bench files are needed. The Jest analysis-control clarification regression separately checks that explicit `false` answers clear missing-input markers without clearing source conflicts.

Optional `expectedModelValues` asserts facts directly from the persisted `/agent/input-review` model, without sending them to chat. Each rule uses a dot-separated `path` and `value`; add `collection` with an optional `id` or `where` filter to inspect records. For example, `{"collection":"elements","where":{"type":"beam"},"path":"design.l0","value":4800}` checks every beam, regardless of its ID, and fails if no beam exists. Use `minMatches` to require multiple matches and `absoluteTolerance` for numeric comparisons. Missing or unequal values make `summary.pass` false even if the report says the design passed. Only configure facts explicitly supplied for that attempt; retain the original failing evidence.


## Choosing A Test

`node backend/tests/draft-update-acceptance.mjs` replays the saved catalog/geometry failure through the shared update path and public build/analysis/query/check/report tools. It freezes independent beam references including self-weight, preserves the original draft, and checks bilingual report values. Missing design conditions must remain `incomplete`. In an isolated `.tmp` runtime configured with a real provider, add `--live` to test the LLM translating the original clarification into an explicit field removal; this makes a paid provider call. It neither modifies Bench nor requires its checkout. The accompanying Jest cases exercise deletion through all eight structural handlers, record-ID merges, atomic rejection and source preservation.

Use the smallest category that proves the behavior:

- Backend logic or route behavior: add or run targeted Jest tests, then run `node tests/runner.mjs backend-regression` if contracts can be affected. Agent orchestration, tool exposure, prompts or run-policy behaviour: also run `npm run test:characterization --prefix backend`. Import or module-boundary changes: run `npm run check:deps --prefix backend`. Python changes: run `npm run test:python --prefix backend`.
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

Model-schema changes also require regenerating `backend/src/engineering/structure-model-v2.schema.json` with the configured product Python: `python backend/scripts/export-model-contract.py`. Run the same command with `--check` in verification. The `draft-contract` regression compares the shipped schema to the running Python protocol, so a stale prompt contract fails independently of TypeScript compilation. Normal installation/build uses the checked-in file and does not require this development generator.

For agent fixes, retain the failing live conversation as well as any passing rerun. Deterministic regressions cover field contracts, stable object identity, missing/confirmation/conflict behavior, builder policy and exact retry feedback. Isolated, opt-in live browser probes verify actual tool execution and saved delivery; compare numerical values with an independent engineering reference. A successful narrative, nonempty result or isolated unit test is insufficient evidence of a working full conversation. Never change the user's active settings or conversations to run these probes.

- E2E covers navigation, i18n/theme, capabilities, database admin, run controls and browser delivery using real engineering services. Live model calls run separately on demand; this is not a full agent quality suite.
- Frontend integration tests have a dedicated local command, but are not wired into CI until the integration runner is stable.
- `install-smoke.yml` now owns native install/build compatibility only.
- `llm-integration` and `llm-benchmark` both touch real LLM behavior today. New agent-quality scenarios should prefer the benchmark path.
- Issue #234 should settle boundaries and documentation first. Separate coverage-expansion issues should add the missing tests.
