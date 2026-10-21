# Bench-300 readiness audit (2026-10-21)

Read-only audit of `work/research-next` (HEAD `8f4ba41`) against the 300-scenario plan
(`tests/llm-benchmark/planning/StructureClaw_Bench_300题规划_求解器补充版_20261013.xlsx`,
`docs/reproducibility/scenario-plan-300-20261013.json`). Per-scenario evidence lives outside the
repo in `G:\StructureClaw-All\bench300-audit\{std,int,mm,infra}.json`.

| Family | Supported | Partial | Missing | Note |
|---|---|---|---|---|
| STD 001–100 | 97 | 3 | 0 | no solver capability missing |
| INT 001–100 | 77 | 23 | 0 | multi-turn mechanics and guards verified by tests |
| MM 001–100 | 26 | 51 | 23 | the 23 missing are all DXF tasks |

The benchmark itself is not changed now (user decision 2026-10-21). This document lists system work
to do before freezing, and records benchmark and environment items for later.

## A. System work (needs user confirmation before execution)

| # | Item | Affects | Priority |
|---|---|---|---|
| S1 | Section numbers that come from an attached table, CSV/XLSX/JSON, DXF or image summary count as user evidence (new `attachment` provenance, bound to the file-evidence record). "确认/按附表" is accepted when the table is attached. Today the evidence check strips attachment text (`agent-langgraph/attachments/input-message.ts:114-117`), so every table-based task stops for confirmation, and in INT the "按附表" reply can never pass and then trips the duplicate-clarification guard. | ~all 300 | blocking |
| S2 | Values derived from user numbers by a stated rule ("B2 Iy = 1.5×B1", "1.4A") count as evidence: the extractor records the rule and the system recomputes and checks it. | INT ×21 | high |
| S3 | A load sign with an explicitly stated convention (e.g. Z-up, D = −8) is not treated as ambiguous. | INT-024 and similar | medium |
| S4 | Concrete-frame template: `rigid_floor` defaults to off unless stated (`concrete-frame/model/records.ts:134`). | STD-069…078, 083/084 | high |
| S5 | PKPM path: when not stated, default `construction_stage=false`, `p_delta=false`, and fill material E/ν/ρ from the grade, so reactions, stations and combinations are always returned. Add a two-material (per storey) native test. | PKPM rows, STD-083 | high |
| S6 | DXF parser: extract dimension measurements; treat circles, arcs, leaders, solids and hatches as annotations instead of marking the file incomplete; emit candidate coordinates the evidence mapping can cite. | MM DXF ×23 | high |
| S7 | A clarification reply may carry attachments (resume accepts files). | MM two-turn ×5 | medium |
| S8 | Store user-requested internal positions (left/right of a load, interior stations) with side tags in the saved run, so any consumer can read exact values without a separate query. | grading of member forces | high |
| S9 | Run-policy switch for strict LLM-only routing (no keyword pre-routing or rule fallback), recorded in the policy hash. Default unchanged. | ablation / benchmark integrity | medium |
| S10 | Duplicate-clarification guard allows a re-ask when the previous answer was reported `unapplied`. | INT robustness | low |
| S11 | Optional: deterministic axis-mapping helper (Y-up source → global Z-up) with tests. | STD-094, INT-094 | low |
| S12 | Reviewed generator for the scenario-freeze manifest (deterministic digests already exist); run it only after all system work is merged. | freeze | before experiments |
| S13 | Decide whether `.json` / `.tsv` uploads are allowed (upload allowlist and frontend accept list). | MM table attachments | decision |

## B. Benchmark items (recorded, not changed now)

- None of the 300 scenarios, truths or attachments are authored yet (150 legacy cases, 18 candidate packs in a different format).
- Evaluator reads stored member results only; exact-position values come from `query_results` (see S8 for a system-side alternative).
- `BENCHMARK_POLICY_VIOLATION` and any unclassified agent error abort the whole batch; should become per-case outcomes.
- No versioned resumable runner (`runner-resume.cjs` and matrix scripts are untracked July copies).
- Tool allowlist omits `edit_model`, `undo_model`, `query_results`, `query_model`, `review_input`, `calculate`; multi-turn edit tasks must rebuild and unit-change follow-ups cannot query; DXF/table attachments cannot be resolved without `review_input`.
- Runner skill list overrides `SCLAW_RUN_PROFILE`; run policy, `policyHash`, `profileId` and `ABLATION_PROFILES_VERSION` are not copied into results; fingerprint misses `dist`, `runtime`, `llm.ts`.
- Scenario schema lacks per-turn attachments, conditional scripted answers, engine target, numerical quantities and global locations; `safe_non_execution` missing.
- Capability map from 2026-10-13 requires a report for every STD task; under report-on-request only STD-006 asks for one.
- Force-only cases that expected an E/I question now solve with placeholder stiffness.
- Representative-18 checker passes `skillScope` instead of `toolContext.skillScope`; report comparator expects the old table layout; STD-036 reference has rotation placeholders for truss joints.
- Images go to a separate vision model in the runner (product image pipeline is not exercised); `LLM_VISION_*` must be set; 4 MB (product) vs 8 MB (runner) limits.
- PKPM/YJK scenarios need `analysisSkillTarget`; multi-turn native cases need longer case timeouts.
- No assertions for "same run, no re-solve", "undo restored", "old result kept as history", "asked only about X".

## C. Environment

- Set `analysis.pythonBin` explicitly; OpenSees 3.8.0 via openseespy 3.7.1.2 verified.
- PKPM / YJK paths present; licences proven only by a real job; kill stray YJK/PKPM processes before start or resume.
- `SCLAW_BENCHMARK_SOLVER_GATE=per-engine`, `SCLAW_BENCHMARK_YJK_COOLDOWN_MS=5000`, `SCLAW_BENCHMARK_BACKEND_PREBUILT=1`, a fresh `SCLAW_DATA_DIR` per run.
- Disk ≈1.6–1.8 GB per pass (no cleanup); 245 GB free.
- Wall time ≈ 400 case runs per model per repetition: 9–28 h sequential, ~1.5–3 h at concurrency 10 (rate limits and YJK queue dominate).
