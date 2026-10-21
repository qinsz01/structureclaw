# Requirements: skills / tools / providers, unified settings, capable generic skill

Status: proposed, for implementation by an agent such as Codex/GPT.
Date: 2026-10-22.
Base branch: `work/research-next`.

Related evidence:
- `docs/refactor/2026-10-21-settings-and-generic-plan.md`
- `docs/refactor/2026-10-21-bench300-readiness.md`

## 0. Rules for the implementer

- Work on a new branch per phase, cut from `work/research-next`. Use small conventional commits. Never push to `upstream`. Never touch `tests/llm-benchmark`.
- No benchmark-specific adjustments: every change must make sense for a real user. Capability limits must fail honestly — structured error, no deadlock, no silent fallback.
- Intent decisions come from the LLM (prompt plus tool arguments). The system validates state and preconditions. Do not add keyword rules on user text.
- Every user-visible string ships in `en` and `zh` through the i18n system.
- Do not run `./sclaw start`; it reinstalls dependencies and restarts the user's dev backend. Do not touch ports 31415/3000. For live runs, start `node backend/dist/index.js` with an isolated `SCLAW_DATA_DIR` on a free port, and pass `LLM_API_KEY` through the environment only.
- Do not use `git worktree remove --force` on worktrees that contain junctions/links (e.g. `backend/.venv` → `sclaw_data/.venv`). Remove the links first.
- Behaviour changes need tests. Update characterization snapshots only for intended changes, and summarise each snapshot diff in the commit message. Bump `ABLATION_PROFILES_VERSION` once per phase and append to the history in `docs/ablation.md` and `docs/ablation_CN.md`.
- Acceptance for every phase must include **real-LLM runs through the real frontend, in a fresh browser profile with default settings** (Playwright), covering several structure types. Scripted tests alone are not acceptance.

---

## 1. Problem summary

"Skill" currently means five different things. There are 42 manifests under `backend/src/agent-skills`:

| Kind | Current "skills" | Code | Problem |
|---|---|---|---|
| Structure modelling method | beam, column, double-span-beam, frame, concrete-frame, portal-frame, truss, generic | `handler.ts` | This is the only real "skill". |
| Solver backend | opensees-static/dynamic/seismic/nonlinear, pkpm-static, yjk-static | `runtime.py` | A backend, but the user must tick it as a skill. |
| Design code | code-check-gb50010/gb50011/gb50017/jgj3 | `entry.ts` | A standard used by `run_code_check`, not a skill. |
| Text only | load-boundary ×10, data-input ×4, validation-structure-model, postprocess-builtin, visualization-frame-summary, report-export-builtin | none | Toggling only changes a description in the prompt. Some texts mention tools that don't exist. |
| Duplicate / dead | memory, shell, skill-creation (duplicating tools); section-bridge/common/irregular | the section skills have `handler.ts` + `runtime.py`, never called | Dead or duplicate. |

Tools: 25, registered in `backend/src/agent-langgraph/tool-registry.ts`. They are coherent and are **not** expanded by this spec.

Settings are spread over:
- localStorage;
- `settings.json`;
- per-conversation state.

Known defects:
- Opening a conversation overwrites the global capability preference (`frontend/.../conversation-selection.ts:94`, `use-capability-catalog.ts:70`).
- The tool-call limit is edited in three places, with silent clamping (`run-policy.ts:155,160`).
- `settings.agent.runPolicy` has no UI.
- Run settings reopen empty although they are saved (`use-console-state.ts:47`).
- Duplicate pages and dialog tabs (`/capabilities`, `/llm`, `/database`).
- The narrowed-scope notice is shown twice.
- `run-settings.tsx` strings bypass i18n.
- Two overlapping Python paths.
- The input-review dialog always sends the global scope (`console-dialogs.tsx:101`).

The generic skill is weak. In the paper, generic-only end-to-end success is 22 % against 82.9 % for auto, and every scenario with vertical members scores 0. Causes:
- member typing (columns written as beams);
- missing stories;
- metadata;
- one-shot JSON for large models;
- hand-distributed loads;
- no stability or load-total checks;
- template leftovers in ingestion (`ingestGenericDraft` keeps only the first load, projects beam/frame scalars);
- missing placeholder stiffness and missing grade defaults.

---

## 2. Target concepts

| Concept | Definition | Members | User interaction |
|---|---|---|---|
| **Skill** | Domain knowledge plus a modelling method for a structure type | Structure-type skills only: beam, column, double-span-beam, frame, concrete-frame, portal-frame, truss, generic | Automatic by default (LLM routing over all skills). An advanced setting may restrict or pin them. |
| **Tool** | An action the agent can execute | The existing 25 tools, grouped Modelling / Analysis / Results & delivery / Conversation / Files / Shell | Not user-facing. |
| **Provider** | A backend capability available by configuration | Solvers (OpenSees modes, PKPM, YJK), design codes (GB 50010/50011/50017, JGJ 3), input parsers (DXF, CSV/Excel/TSV/JSON, image, PDF), report exporters (built-in, PKPM calculation book) | Settings shows installed/configured status. The agent picks a provider per task through tool arguments (e.g. `run_analysis.analysisSkillId` → engine). The user never ticks providers as skills. |
| **Engineering knowledge** | Shared domain guidance text | Content of the current text-only skills (loads, boundaries, combinations, input formats, validation, post-processing) | Not toggleable. Injected where relevant (extractor, builder, system prompt) under the `knowledge` run-policy switch. |

---

## 3. Phase 1: concept cleanup and unified settings

### 3.1 Providers split out of skills

- **R1.1** Introduce a provider catalog in `backend/src/providers/` (or a similarly clear location consistent with the dependency-cruiser layering) with kinds `solver`, `design-code`, `input-parser` and `report-exporter`. Each entry has: id, kind, bilingual name and description, capability metadata (analysis types, dimensions, code), and an availability probe (configured / installed / licence unknown).
  - Reuse the existing `skill.yaml` metadata and `agent-skills/analysis/catalog.ts`. The Python runtimes and their paths stay where they are; only the catalog/meta-layer moves.
- **R1.2** Selecting providers is no longer gated by skill selection:
  - `run_analysis` accepts any *available* solver.
  - `run_code_check` accepts any available design code.
  - If the user names an engine that is unavailable, return the existing structured `ENGINE_UNAVAILABLE`, and the agent tells the user.
  - Remove `ANALYSIS_PROVIDER_NOT_SELECTED` as a user-facing concept, or map it to "provider disabled in settings" if the user explicitly disabled it (see R1.3).
- **R1.3** Settings → "Engines & codes" lets the user disable a provider explicitly, e.g. "never use YJK". The default is: all available providers enabled.
- **R1.4** Keep backward compatibility for API clients and saved sessions that send provider ids inside `skillIds`: map them to provider preferences, and never error. Add a test.
- **R1.5** `set_session_config` keeps `analysisType` / `designCode`. Its `skillIdsJson` must only accept structure-type skills; provider ids passed there are mapped per R1.4.

### 3.2 Text-only skills become engineering knowledge

- **R1.6** Move the useful content of these into a single engineering-knowledge module, organised by topic (loads, boundary conditions, combinations, input formats, validation, post-processing):
  - load-boundary/* (10)
  - data-input/* (4)
  - validation-structure-model
  - postprocess-builtin
  - visualization-frame-summary
  - report-export-builtin
- **R1.7** Delete every sentence that references a non-existent tool or API (e.g. `generate_load_combinations`).
- **R1.8** Inject topic knowledge where it is used (extractor, LLM model builder, system prompt). Keep it short and principle-level. The `knowledge: disabled` ablation must remove it, and there must be a test.
- **R1.9** Delete the skill manifests for these entries. Map old ids found in saved preferences or sessions to "no-op" (ignored with a log line).

### 3.3 Duplicates and dead code

- **R1.10** Delete the `memory`, `shell` and `skill-creation` skills (the tools exist). Check that skill creation is not used by SkillHub or the frontend; if it is, report it and keep only the tool path.
- **R1.11** Section skills:
  - Determine whether `section-common/runtime.py` computes anything the protocol's `section_properties.py` lacks (e.g. irregular or bridge sections).
  - If yes, fold that computation into the shared section-property code with tests.
  - Otherwise delete all three.
  - Document the decision in the commit.

### 3.4 Unified settings

- **R1.12** One settings dialog with these sections:
  - Model: LLM and vision.
  - Engines & codes: solver paths (Python/OpenSees, PKPM, YJK), status, provider enable/disable.
  - Skills: structure-type skills; automatic by default; advanced restrict/pin.
  - Run policy defaults: knowledge, builder, repair, history, tool-call limit, LLM-call limit, memory; this is the UI for `settings.agent.runPolicy`.
  - Appearance: theme, locale, layout.
  - Data: database status.
  
  `/capabilities`, `/llm` and `/database` become deep links that open the corresponding section.
- **R1.13** Three scopes, each edited in exactly one place:
  - *Global defaults*: the settings dialog.
  - *Conversation override*: a visible control in the conversation header (skills restriction/pin, run-policy overrides). It is persisted with the conversation and shown again on reopen.
  - *Turn*: no hidden state. The composer shows the effective scope as a single compact line.
- **R1.14** Opening or switching conversations never writes global preferences. Remove the copy in `conversation-selection.ts:94` and `use-capability-catalog.ts:70`. Input review uses the conversation's effective scope.
- **R1.15** Tool-call limit: one source (run-policy defaults). The server ceiling is shown next to the control. Requests above it are rejected with a visible message instead of silently clamped. Remove `agent.maxToolCallsPerTurn` from General, keeping read compatibility for old settings files.
- **R1.16** One narrowed-scope notice. All run-settings strings go through i18n. Keep a single analysis Python path; the YJK SDK interpreter stays separate only if technically required, and its label says so.
- **R1.17** Migration: existing localStorage preferences without `explicit: true` are treated as defaults (already the behaviour). Existing explicit preferences that contain provider or text-only skill ids are migrated per R1.4 and R1.9.

### 3.5 Ablation profiles

- **R1.18** Update `runtime/ablation-profiles.ts` so profiles restrict structure skills only.
  - `generic-only` = generic plus all providers.
  - `no-knowledge` additionally removes the engineering-knowledge module.
  - Any profile that previously restricted engines must now restrict providers.
- **R1.19** Bump the version and update the docs.

### 3.6 Phase 1 acceptance

- All automated suites pass:
  - `rm -rf backend/dist`, `db:generate`, `build`, `lint`, `check:deps`;
  - full Jest, `test:python`, `node tests/runner.mjs analysis-regression`;
  - 3 validators;
  - frontend `type-check`, `lint`, `test:run`, `test:run:integration`, `build`;
  - default e2e.
- New tests:
  - provider selection independent of skill selection;
  - legacy `skillIds` containing provider/text-only ids;
  - settings migration;
  - opening a conversation does not change global preferences;
  - tool-call limit single source;
  - knowledge injection obeys `knowledge: disabled`.
- Live, real LLM, real frontend, fresh browser profile, default settings:
  - concrete frame (the user's sentence "计算一个2*2的小混凝土框架，跨度5m，高度3米每层，一共两层，其他材料你自己安排，荷载除了地面外每个节点都有100N的x方向荷载"), ×2;
  - steel frame;
  - truss;
  - I20a beam;
  - "用PKPM算" on a small frame — the solver is selected without ticking any skill;
  - a GB 50017 check request — the code is selected without ticking any skill.
- Screenshots of every settings section in zh/en, light and dark themes.

---

## 4. Phase 2: generic skill as a capable free-form modeller (P1)

- **R2.1** Remove template leftovers from generic ingestion:
  - `ingestGenericDraft` (`agent-runtime/draft/boundary.ts:469-551`) keeps the canonical `engineeringDraft` plus the user text;
  - all loads are preserved, not only the first;
  - no beam/frame scalar projection and no `normalizeFrameBoundary` for generic;
  - `skill.yaml` `structuralTypeKeys` for generic lists only `unknown` / free-form.
- **R2.2** Add a principle-level modelling-conventions block to the LLM model builder prompt (`generic/llm-model-prompt*.ts`):
  - member roles (beam / column / truss / brace by orientation and function);
  - stories when storeys exist;
  - section `purpose`;
  - releases;
  - local axis (`rotation_angle`);
  - supports;
  - units.
  
  Also include the section-evidence rule and the load-direction rule, which today exist only in the agent and extractor prompts.
- **R2.3** Shared completion for generic, using the same code paths as the templates:
  - force-only requests → placeholder unit stiffness;
  - known material grades → material constants;
  - confirmed or evidenced section geometry → properties.
- **R2.4** Deterministic post-build physics checker (shared module) feeding the builder's repair loop. It checks:
  - disconnected or orphan nodes;
  - mechanisms / rigid-body modes (zero-pivot or rank check on the assembled stiffness, or an equivalent graph and DOF check);
  - zero-length or duplicate members;
  - vertical members typed as `beam` when a column role is intended;
  - total applied load vs the request;
  - supports present.
  
  Diagnostics are structured and bilingual. The repair budget is controlled by run policy (default 2). When the budget is exhausted, end honestly with the remaining diagnostics.
- **R2.5** Generic readiness = physics checklist: geometry closed, supports given, loads targeted, properties given or force-only. Ask only for genuinely missing physics, all at once.
- **R2.6** Phase 2 acceptance:
  - automated suites as in 3.6;
  - new characterization fixtures for generic with a scripted LLM: 2-storey frame, portal, arch, inclined truss, 3D grid, mixed frame+brace;
  - checker unit tests with true and false positives;
  - live, real LLM, real frontend, fresh profile, **generic only** (restricted in the conversation override): 2-storey 2-bay frame, portal, arch, inclined truss, 3D 2×2 grid, plus one structure with no template (e.g. a frame with a cantilever and a diagonal brace). Report pass, questions, tool calls and key numbers vs hand checks.
  - Also run the default-settings cases from 3.6 to confirm specialised routing is unaffected.

---

## 5. Phase 3: generic modelling operations (P2/P3)

- **R3.1** Do **not** add new agent tools. Extend the generic builder's output contract so the LLM may emit **modelling operations** as well as explicit records. A shared deterministic expander in `skill-shared/` turns operations into StructureModel v2. Extract the expanders from the existing specialised builders and reuse them; do not duplicate.
  
  Operations:
  - regular grid/frame (bay widths, storey heights, 2D/3D, base restraint);
  - truss panels (topology, span, height, panel count);
  - polyline / arc with segment count;
  - replicate / mirror / translate;
  - merge coincident nodes;
  - member UDL / point load by selector;
  - floor-to-beam load (one-way / two-way);
  - property assignment by selector.
- **R3.2** Partial user topology: the LLM completes it while preserving user IDs, with a check.
- **R3.3** Generic report narrative: supports, load totals, governing results.
- **R3.4** Merge the duplicated frame builders (`agent-runtime/model-builder/frame.ts` and `structure-type/frame/model/*`) behind the shared expanders. Specialised skills keep their behaviour; their characterization snapshots must not change except where intended.
- **R3.5** Phase 3 acceptance: automated suites as before, plus the Phase 2 live matrix. Generic-only pass rate and question count must improve over Phase 2, measured and reported.

---

## 6. Out of scope

- Benchmark runner, evaluator and scenario authoring.
- The new scenario freeze. Generate it only after all phases are merged, with `scripts/generate-scenario-freeze.mjs`.
- Section catalogues: still none; table values recalled by the assistant still require user confirmation.

## 7. Deliverables per phase

- Branch name, commits, a short design note in `docs/refactor/`, test summary lines, and a live acceptance table (wall time, user turns, questions, tool calls, key numbers vs hand checks, evidence paths).
- A list of anything not achieved, stated honestly.
