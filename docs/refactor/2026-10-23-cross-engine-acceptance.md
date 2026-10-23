# 跨结构、跨引擎全链路验收 / Cross-engine acceptance

2026-10-23。应用的 8 个结构技能、23 个结构算例分别提交到 OpenSees、PKPM、YJK，共 69 个组合：35 个实际求解并保存报告，34 个按能力边界明确拒绝。另有 10 个真实 GLM-5.3 会话覆盖全部 8 个结构技能，最终均通过。所有请求使用隔离数据库及工作目录；没有改写用户会话、设置或 Bench。

This is product acceptance, not a benchmark score or a guarantee for arbitrary prompts/models. Only the LLM transport is scripted in the deterministic matrix; HTTP, graph, skills, compilation, validation, native solvers, persistence, result queries and reports are real. The separate live sessions use the configured real provider. Skill use is asserted from `modeling.usedSkillIds`, rather than inferred from the selected route.

## Fixed framework defects

1. Grade-derived G was rounded independently of E and Poisson ratio, so PKPM rejected framework-generated isotropic materials. Derive omitted G consistently; preserve explicit constants, including authored overrides.
2. A commercial batch received only the first result selection. Request the union of all contributing source cases once, then publish each original case/combination with its own binding and factors. Do not rerun a failed native projection.
3. Failure compaction hid per-result causes and the archive identity. Preserve bounded failed-result diagnostics, input fields, run ID and result keys.
4. A nonlinear input audit with `execution.executed=false` was published as successful analysis. Reject explicit nonexecution for Python and HTTP solver receipts; no substitute solve or successful analysis/report publication. The catalog now states that full-member nonlinear execution is unimplemented.
5. Unsupported PKPM dimensions, missing natural stories, column axes/shapes and SDK grades surfaced as execution failures or pre-conversion errors. Return precise capability failures, and reject 2-D inputs before native planning/SDK calls. YJK floor totals without verified explicit nodal equivalents are now rejected before launching the SDK; the original run reached physical verification and returned an imprecise execution error.
6. PKPM rejected framework-owned section provenance as an uncalibrated physical override. Retain recognized audit records, validate derived properties, and continue rejecting unknown physical extensions, malformed provenance and unconfirmed table recall. Discarded properties remain auditable and cannot control stiffness.
7. Regular frame templates merged named floor actions into anonymous cases and projected live gravity loads into the dead-load channel. Preserve confirmed case IDs/types, separate dead/live totals and retain combination factors. Concrete beam line loads also retain source case IDs, and legacy line-load deduplication must preserve explicitly confirmed floor totals. An aggregated floor channel cannot represent multiple distinct case IDs; reject it explicitly and request per-case member/node loads. The elastic frame path also rejects mixing floor totals with explicit loads in the same case, which previously could omit the floor load.

## Static matrix

`✓` means actual solver results and a current saved report. `拒绝` means an asserted capability rejection with no solver substitution or successful analysis/report publication.

| Fixture | OpenSees | PKPM | YJK |
| --- | --- | --- | --- |
| Simply supported point-loaded beam | ✓ | 拒绝 | 拒绝 |
| Unequal three-span continuous beam | ✓ | 拒绝 | 拒绝 |
| Column under axial and lateral loads | ✓ | 拒绝 | 拒绝 |
| Two-storey steel frame (2-D) | ✓ | 拒绝 | 拒绝 |
| Two-bay portal | ✓ | 拒绝 | 拒绝 |
| Concrete frame (2-D) | ✓ | 拒绝 | 拒绝 |
| Four-panel truss | ✓ | 拒绝 | 拒绝 |
| 3-D steel frame, Q235B/H columns | ✓ | 拒绝 | ✓ |
| 3-D concrete frame, C40/HRB500 | ✓ | ✓ | ✓ |
| Generic two-storey frame | ✓ | 拒绝 | 拒绝 |
| Generic pitched portal | ✓ | 拒绝 | 拒绝 |
| Generic arch | ✓ | 拒绝 | 拒绝 |
| Inclined truss | ✓ | 拒绝 | 拒绝 |
| 3-D grid without natural stories | ✓ | 拒绝 | 拒绝 |
| Mixed frame and axial brace | ✓ | 拒绝 | 拒绝 |
| 3-D steel rectangular frame, Q235B | ✓ | 拒绝 | ✓ |
| 3-D steel rectangular frame, Q235 | ✓ | ✓ | ✓ |
| Same geometry with confirmed provenance/derived-property audit | ✓ | ✓ | ✓ |
| Two-storey 3-D Q235 steel frame, named nodal DL/LL | ✓ | ✓ | ✓ |
| Two-storey 3-D C40/HRB500 frame, named nodal DL/LL | ✓ | ✓ | ✓ |
| Two-storey 3-D Q235 frame, named floor-total DL/LL | ✓ | 拒绝 | 拒绝 |
| Two-storey 3-D C40/HRB500 frame, named floor-total DL/LL | ✓ | 拒绝 | 拒绝 |
| Concrete frame, separate floor DL / roof LL / beam-line SDL | ✓ | 拒绝 | 拒绝 |

The commercial adapters require canonical 3-D building inputs and explicit natural stories. Their declared model families exclude pure trusses. The installed PKPM SDK does not accept Q235B, and calibrated H-column axes are unsupported. These failing inputs remain separate fixtures; the supported Q235 rectangular case is a distinct input.

Every solved selection is checked for force equilibrium against declared inputs, exact engine identity, case/combination identity, null fallback, current report and persisted scalar/unit queries. Independent references cover `PL³/(48EI)`, the three-moment equation and `PL/(EA)`. The metadata fixture retains a discarded `J=999` audit value while requiring the operative geometric properties and analytical displacement.

The two-storey cases explicitly select `node_tributary` for floor transfer. Dead load is 100 kN on each floor; live load is 50 kN on the roof only. `ULS = 1.3 DL + 1.5 LL` therefore totals 335 kN. Independent displacement checks use each column segment's actual axial force and length. These checks do not establish commercial-engine floor/slab transfer support: those paths must refuse unsupported floor-total inputs rather than substitute explicit nodal loads.

## Other analysis paths and real sessions

- Full persisted modal flow: analytical cantilever period, actual OpenSees result and saved report.
- Two time-history flows: requested observation nodes/frames and response scaling under doubled excitation, with saved reports.
- Full-member nonlinear execution: explicit failure even if an input audit is complete; never present an audit as a solve.
- Seismic analysis without its required workflow: explicit missing-input failure, no substitute results/report.
- Real GLM-5.3: beam, continuous beam, column, portal, truss, 3-D steel frame/PKPM, 3-D concrete frame/YJK, generic mixed frame, arch and the two-storey named-floor case. Original failures are retained; commercial cases were retaken after their fixes. Engine IDs, source-case totals, combination factors and saved reports are checked; no code design was requested or executed.

These live inputs are explicit and use fixed structure-skill scopes and requested engines. They establish working framework paths, not general LLM interpretation accuracy. Automatic routing, empty/generic-only scopes, missing LLMs, clarification, bounded repair, stale-result rejection and state retention are covered by the separate regression/characterization suites.

## Verification and reproduction

- The final static matrix combines a complete 66-cell run with nine targeted retakes/new cells, deduplicated to 69 combinations. The original YJK floor-transfer execution failure remains in evidence; the final retake asserts its precise pre-execution capability failure. All 50 independent analytical check groups passed.
- 243 unique Jest suites / 3,569 tests; zero unresolved failures or local skips. This combines full core/characterization runs with complete affected-suite retakes, plus the new analysis-mode and floor-case suites; it is **not** a claim that every intermediate full command was green. The floor-case repair was followed by 31 affected suites / 806 passing tests, including 26 new floor-case tests.
- Python: 1,303 tests and 30 subtests passed, including four new floor-transfer capability tests.
- Full analysis regression, seven selected contracts, TypeScript build, lint and dependency checks passed.
- Frozen input fixtures, snapshots and Bench were not rewritten. G assertions now use the isotropic relation; explicit authored G is preserved. Numerical tolerances and existing test timeouts were not relaxed.
- Heavy dependency loading was moved outside a test's execution hook. Generic equilibrium tests still check every support/component from the immutable run, with public scalar-query cross-checks, instead of repeatedly checkpointing the whole graph for each support. Parallel cold-start timeouts and earlier failed attempts remain in the evidence.

The native contract test visibly skips when the analysis Python is unavailable (e.g. a minimal unit-only CI environment). That is a coverage gap, not a numerical solver pass. The local verification above used the installed runtime and all three commercial/OpenSees paths. An unavailable requested engine stops matrix preflight.

```powershell
$env:SCLAW_TEST_PYTHON = '<analysis-runtime-python>'
npm run build --prefix backend
node backend/tests/structure-engine-acceptance.mjs --native-settings=<settings-path> --output=<isolated-evidence>
# Without commercial installations, explicitly select the OpenSees matrix:
node backend/tests/structure-engine-acceptance.mjs --engine=opensees-static --output=<isolated-evidence>
npm run test:characterization --prefix backend
```

`--native-settings` copies only allowlisted installation/runtime paths. Test-owned native work directories and an explicitly scripted provider are used; user credentials, database and native work directories are not copied. The live verification relayed the configured provider in memory and retained no credential headers.
