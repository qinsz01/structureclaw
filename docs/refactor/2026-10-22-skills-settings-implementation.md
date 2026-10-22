# Skills, providers, settings and generic modelling implementation

Specification: `2026-10-22-skills-tools-settings-spec.md` (all three phases).
Baseline: `70c3c8b1`, `work/research-next`. Benchmark sources and historical freezes are excluded.

## Phase 1 — `refactor/skills-settings-phase1`

Design: structure methods remain skills; configured backends, standards, parsers and exporters
have a separate provider catalog. Legacy capability ids are migrated at the input boundary.
Shared engineering guidance is short, topic-based and controlled by the knowledge policy.
Global defaults live in settings, conversation overrides remain local to their conversation,
and the composer displays the effective scope. Provider disables are explicit settings.

Historical Phase 1 status: implementation and automated acceptance passed; its initial live
snapshot exposed the modelling issues below. Their integrated resolutions and final measurements
are recorded in Phase 3, rather than rewriting the initial observations as passes.

Implemented: 8 structure skills; 16 provider definitions shared by TypeScript and Python;
explicit provider disables; legacy capability migration; topic knowledge under the knowledge
switch; removal of duplicate/placeholder skill implementations; six settings sections;
conversation-local overrides and scope display; budget migration and explicit ceiling errors.

Section decision: the old common runtime contained a useful solid-polygon centroid/inertia
integration absent from the shared protocol. It is now `polygon_properties` in the shared
section-property module, with translated/concave/degenerate outline tests. Bridge/irregular
runtime results were approximate or placeholders, not reliable additional section solvers.
No SkillHub or frontend dependency on the removed skill-creation manifest was found; file/shell
tools remain the creation path.

Evidence directory: `G:/StructureClaw-All/verification/skills-settings-20261022/phase1/`.
Verified: clean Prisma generation/build, backend lint/dependency rules, 214 Jest suites / 3153 tests /
57 snapshots, 1290 Python tests, analysis regression and all three validators. Frontend type/lint/
production build, 327 unit tests, 83 integration tests; default E2E 54 passed / 12 live-only skipped.
All six settings sections passed en/zh × light/dark; 32 screenshots plus an inspected overview
are in `phase1/settings-screenshots`. Follow-up extraction/catalog fixes passed 58 targeted tests.

Live default-model observations (`glm-5.3`, `phase1/live-defaults`, real frontend, fresh context
per case, no route mocks). These are observations, not a claim that every case passed cleanly:

| Case | Seconds | User turns | Question groups | Tool calls | Independent check / outcome |
|---|---:|---:|---:|---:|---|
| Original concrete frame 1 | 303.8 | 2 | 2 | 9 | Asked again for X grid and floor loads; no solve |
| Original concrete frame 2 | 464.9 | 2 | 1 | 13 | Final base Fx = −1.800000 kN; two different solves require audit |
| Steel frame | 163.1 | 1 | 0 | 9 | Base Fx = −60.000000 kN vs −60 |
| Triangle truss | 150.1 | 1 | 0 | 10 | Reactions 5 + 5 kN; max axial 7.071068 kN |
| I20a beam, user properties | 151.6 | 1 | 0 | 9 | Reactions 10 + 10 kN; moment 10 kNm; deflection 3.413762 mm |
| Explicit PKPM frame | 159.9 | 1 | 1 | 4 | Blocked by redundant floor-load prerequisite; provider job not reached |
| GB50017 request | 176.9 | 1 | 0 | 6 | Code tool called independently; reactions 10 + 10 kN; missing design inputs remain explicit |

The I20a hand check is 5qL⁴/(384EI), with q=5 kN/m, L=4m, E=206000000 kN/m²,
I=0.0000237 m⁴. A browser inspector-cache eviction affected stream capture on concrete 2;
authoritative conversation/run JSON and screenshot remain. The earlier `phase1/live` exploratory
attempt used an inherited old model instead of the saved default, failed extraction and was
stopped; its evidence is retained. The harness now honours saved model settings and tolerates
stream-body cache eviction. No failed attempt was erased.

Follow-up: the focused extractor omitted 3D grid and load target fields; it now derives them from
the canonical contract. Concrete-frame nodal-load readiness and duplicated frame generation
remain to be addressed and remeasured. Commercial licence availability has not yet been tested
by this live matrix because PKPM stopped before the provider call.

Characterization changes: 39 snapshots in the policy/profile suites change skill lists, provider
guidance, knowledge text, policy hashes and profile metadata; one further tool-schema snapshot
changes the analysis provider description. Numerical structural characterizations are unchanged.
The old dist directory was archived outside the repository before the clean build, because the
automatic approval review rejected recursive deletion; the clean build contains no old section
handlers.

Requirements to verify: R1.1–R1.19; clean backend build, Prisma generation, lint, dependency
rules, full Jest/Python/regression suites, three validators; frontend type/lint/unit/integration/
production build/default E2E; real-LLM frontend acceptance matrix and settings screenshots.

## Phase 2 — generic free-form modelling

Branch: `refactor/generic-physics-phase2`; implementation `d6498fea`, tests `8678ca93`.
R2.1–R2.5 implemented: canonical input plus text, all loads retained, unknown-only generic
type keys, physical conventions/evidence/direction rules, shared material/section/unit-stiffness
completion, physics readiness and policy-controlled repair (initial attempt plus default two repairs).

The checker uses kinematic compatibility rank, equivalent to the nullspace of positive line-member
stiffness. It excludes inactive hinge rotations, detects supported mechanisms and rigid modes,
and separately reports connectivity, roles, duplicates, zero lengths and load totals. Independent,
supported components are warnings. Non-line element stability is explicitly unsupported, not a
claimed successful check; ambiguous abstract load targets receive a verification warning.

Automated acceptance: 217 Jest suites / 3181 tests / 57 snapshots passed in 938.5s
(`phase2/backend-clean-final.log`); all 1290 Python tests, analysis regression and three validators
passed. Backend Prisma/build/lint/dependency rules and frontend type/lint/production build passed;
327 frontend unit and 83 integration tests passed. Default E2E: 54 passed / 12 live-only skipped.
The six scripted-LLM graph fixtures reach real OpenSees and independently balance support reactions.

The initial full run exposed a non-finite rotation that could stall rank elimination. The checker
now rejects non-finite kinematics before and during elimination; the clean full run finishes.
Empty extracted load-case stubs also falsely implied zero loads; they no longer override separately
declared physical loads. Tests distinguish empty stubs from explicit zero-load intent. The worktree
uses the same analysis Python via a junction, rather than the WindowsApps Python stub.
Updated compatibility expectations use canonical fields and stable supports. Snapshot changes in
`3364c1d6`: 18 profile and 10 policy snapshots change only the generic description and corresponding
prompt hashes/lengths. Numerical snapshots are unchanged.

Real frontend / `glm-5.3`, fresh browser context, conversation scope exactly `['generic']`:

| Initial case | Seconds | Turns | Issued questions | Tool calls | Independently checked outcome |
|---|---:|---:|---:|---:|---|
| 2-storey, 2-bay frame | 1086.3 | 1 | 1 | 8 | No solve: false zero-load diagnostic from empty case stub |
| Portal | 392.6 | 1 | 0 | 7 | 5 nodes / 4 members; reactions 10 + 10 kN |
| 12-segment arch | 363.7 | 1 | 0 | 5 | 13 nodes / 12 members, A/B/C preserved; reactions 5 + 5 kN |
| Inclined truss | 244.1 | 1 | 0 | 10 | 3 nodes / 3 members, A/B/C preserved; reactions 5 + 5 kN |
| 3D 2×2 grid, 2 storeys | 369.5 | 1 | 0 | 6 | 27 nodes / 42 members / 18 loads; base Fx −1.8 kN |
| Frame, cantilever and brace | 261.7 | 1 | 1 | 3 | Correctly asks for the omitted axial-brace area; no solve |

Initial completion: 4/6, two issued question groups. Evidence: `phase2/live-generic`.
Subsequent corrections are kept separate, not substituted into this baseline:

| Follow-up | Seconds | Turns | Issued questions | Tool calls | Outcome |
|---|---:|---:|---:|---:|---|
| Frame after empty-case fix | 285.6 | 1 | 0 | 6 | 9 nodes / 10 members / 6 loads; base Fx −60 kN |
| Mixed structure, same initial prompt then AD area 0.002m² when asked | 591.4 | 2 | 1 | 22 | 5 nodes / 5 members / 2 loads; base Fx/Fz −5/+10 kN; first three analysis calls rejected, final solve correct |
| Extra scale probe: 4×4 bays, 4 storeys | 654.1 | 1 | 0 | 7 | 125 nodes / 260 members / 100 loads, A preserved; base Fx −10 kN |

Evidence: `phase2/live-defaults-and-fix`, `phase2/live-mixed-followup`, `phase2/live-scale`.
With the correction the fully specified first-turn cases pass 5/6; the mixed case needs its genuine
missing area and then passes. There is no basis to claim that a later operations implementation can
remove that necessary question. The scale probe also already passes without operations.

Default-route regression (`phase2/live-defaults-and-fix`) retained the first sentence and specified
clarification protocol from Phase 1. Concrete 1: 287.4s / 2 turns / 2 issued questions (one additional
proposal rejected before delivery) / 11 tool calls; concrete 2: 158.6s / 2 turns / 2 questions / 6 calls.
Both still ask redundantly for floor totals instead of using their explicit node loads. Steel frame:
123.2s / 1 turn / 0 questions / 6 calls, base Fx −60 kN. Truss: 132.9s / 1 / 0 / 5, reactions 5 + 5 kN
and axial 7.071068 kN. I20a: 174.4s / 1 / 0 / 11, reactions 10 + 10 kN, moment 10 kNm, displacement
3.413762 mm. PKPM: 200.9s / 1 / 1 / 3, redundant floor prerequisite, provider not reached. GB50017:
185.2s / 1 / 0 / 10, code tool reached; no invented overall compliance result.

Hand checks and model/run snapshots are audited in the external evidence file `live-audit.json`.
Question counts exclude refused proposals and include pending interrupts; tool counts use the saved
runtime ledger, including after clarification. The original arithmetic literal for I20a was corrected
to 5qL⁴/(384EI); observed solver displacement did not change. No failed run was erased.

## Phase 3 — shared modelling operations

Branch: `refactor/generic-operations-phase3`. Shared extraction `d41a61b1`, generic contract/report
`65eea060`, operation/equilibrium tests `d171ee9a`, selector preflight `99793fec`.
Version: `2026-10-22.3`; the Agent registry remains 25 tools (shell is separately disabled in live tests).

The generic builder accepts explicit V2 records and/or 14 operation variants in the same JSON.
Shared geometry expands regular 2D/3D frames, panel trusses, polylines and segmented arcs; selectors
apply properties, restraints and node/member loads; transforms replicate, translate, mirror and
merge coincident nodes. Partial user records may anchor generated geometry; known IDs, coordinates,
restraints and assignments are checked before accepting the completion. A failed expansion feeds
the existing policy-controlled repair loop and returns structured diagnostics without replacing
the saved model. Replication copies loads only when requested; geometry transforms do not silently
change global load vectors. Unsupported or unmatched selectors fail rather than dropping input.

Frame geometry is extracted from the existing runtime and structure-type builders, including
concrete 2D/3D adapters. Specialised adapters keep their existing load and material handling, IDs and
ordering. The old unused 2D node-load implementation is removed; structured per-node actions share
one 2D/3D target expander, preserving individual actions and case IDs rather than requiring floor
totals. Regression tests cover 18×100N = 1.8kN and four corner loads of 10kN = 40kN in both builders.

Floor transfer reuses the existing Python one-/two-way panel algorithms through an internal protocol
action, without adding an Agent tool. Explicit bounds and support beams are required; unsupported
panels fail. Partial member intervals are retained, qA is checked independently, and all three modes
(one-way X/Y and two-way) reach real OpenSees with 240kN support equilibrium. The original Python
import path remains a thin compatibility class. All 58 historical methods still resolve.

Generic reports describe supports, explicit applied-load totals excluding self-weight, and governing
metrics with recorded engine units and controlling identities. Force-only unit stiffness is labelled
and does not produce a claimed physical displacement. English/Chinese tests cover both paths.

Live testing found a pre-existing orchestration bug: an invented case ID (L1 instead of LC1) failed
before solving but was labelled SOLVER_OUTCOME_UNKNOWN, which then blocked correction. Selection
now uses the existing deterministic selection validator before reserving a job or invalidating a
result, with bilingual diagnostics and available IDs. Actual uncertain solver outcomes remain
protected. A full scripted Agent turn corrects L1 to LC1 and reaches real OpenSees with zero repairs.

Verified: 220 Jest suites / 3213 tests / 57 snapshots passed in 988.6s
(`phase3/backend-final-success.log`); 1292 Python tests; 327 frontend unit / 83 integration tests; frontend type/lint and
production build; backend build/lint/dependency rules; analysis regression and three validators.
Default browser E2E: 54 passed / 12 live-only skipped in 30.1 minutes (`phase3/e2e.log`).
Operation tests: 14 pass, including real slab solves and bounded failure with the saved model intact.
The first full Jest attempt found one intentionally changed old readiness expectation, now explicitly
documented and passing in all 57 compatibility tests. Concurrent compilation also interfered with
eight Jest module imports. Another invocation used the repository rather than backend working
directory and failed four path-sensitive suites; their source was not changed to hide that setup
error. The final full run uses the backend directory and a fixed compiled tree
(`phase3/backend-final-success.log`). The final full Jest and live follow-ups below have completed.
Earlier interrupted runs were stopped when new real-input defects required a
correction; none is counted as a complete full-suite pass.

The live mixed case exposed a second invalid apparent success: the LLM invented a labelled unit
brace area beside real beam/column sections. This is excluded from the pass count. Only the host
may create placeholder stiffness and its metadata; partial real-property models must supply the
missing properties. Redundant rotational hinges on pure axial members retain their authored
definitions and are realized by the axial formulation, with a bilingual equivalence diagnostic;
translational releases and released offsets remain unsupported. Native triangle tests prove unchanged
forces, 5 + 5kN reactions and input immutability for both truss and brace types. Explicit
OpenSees selection also retains the eligible force-only unit-stiffness path; commercial targets
still require real properties. These changes passed focused physics/stiffness/compatibility tests.

The initial concrete runs also exposed a 2D-only node-role instruction being applied to 3D grids.
The formal draft contract now documents global upper-node selectors and 3D grid indices; the
specialised guidance limits side roles to 2D. Per-node force and load-ID replacement principles
live once in shared knowledge; ambiguous/duplicated old node-to-floor examples were removed.
Intentional Phase 3 snapshot changes (`d74247a2`): 18 profile and 10 policy snapshots change only
shared load guidance and prompt lengths/hashes. Numerical results, policy hashes and no-knowledge
snapshots are unchanged; all 35 targeted tests / 44 snapshots passed.

Initial Phase 3 real frontend matrix (`phase3/live`, saved `glm-5.3`, fresh contexts):

| Case | Seconds | Turns | Issued questions | Tool calls | Independent outcome |
|---|---:|---:|---:|---:|---|
| Generic frame | 494.0 | 1 | 0 | 10 | 9 nodes / 10 members / 6 loads; base Fx −60kN |
| Generic portal | 295.0 | 1 | 0 | 7 | Reactions 10 + 10kN |
| Generic arch | 348.2 | 1 | 0 | 5 | 13 upper-semicircle nodes, A/B/C preserved; reactions 5 + 5kN |
| Generic inclined truss | 262.8 | 1 | 0 | 5 | Pure axial members, supplied coordinates preserved; reactions 5 + 5kN |
| Generic 3D grid | 331.6 | 1 | 0 | 17 | No solve: wrong L1 selector became a false uncertain-outcome lock |
| Generic mixed structure | 901.7 | 1 | 0 | 14 | Excluded: invented partial unit brace stiffness, despite balanced reactions |
| Extra scale probe | 461.9 | 1 | 0 | 7 | 125 nodes / 260 members / 100 loads, A preserved, base Fx −10kN; operations used |
| Original concrete 1 | 748.0 | 2 | 1 | 17 | Final 27/42/18, −1.8kN; unnecessary retries and generic fallback |
| Original concrete 2 | 1009.3 | 2 | 1 | 43 | Final 27/42/18, −1.8kN; one refused proposal and unnecessary retries |
| Steel frame | 126.4 | 1 | 0 | 6 | Base Fx −60kN |
| Triangle truss | 163.4 | 1 | 0 | 5 | Reactions 5 + 5kN, axial 7.071068kN |
| I20a | 116.9 | 1 | 0 | 5 | Reactions 10 + 10kN, moment 10kNm, deflection 3.413762mm |
| PKPM | 312.7 | 1 | 0 | 30 | Same wrong-case lock, no native solve; licence still not established |
| GB50017 | 186.1 | 1 | 0 | 9 | Code tool called independently; analysis 10 + 10kN and 10kNm |

Initial required generic completion: 4/6. A reduction in questions obtained by inventing a brace
section is not accepted as an improvement. After selector preflight, a fresh 3D grid run passed in
560.6s / 1 turn / 0 questions / 7 calls, using regular-frame and nodal-load operations, with
27 nodes / 42 members / 18 per-node actions and −1.8kN (`phase3/live-grid-followup`).
The mixed case and original concrete/PKPM requests were remeasured after the stiffness and
node-selector corrections. The completed follow-ups are separated below and initial failures stay
in the table.

| Final follow-up | Seconds | Turns | Issued questions | Tool calls | Independently checked outcome |
|---|---:|---:|---:|---:|---|
| Original concrete 1 | 234.6 | 2 | 1 | 9 | Specialised template; 27 nodes / 42 members / 18 loads; base Fx −1.8kN |
| Original concrete 2 | 201.9 | 2 | 1 | 10 | Specialised template; same counts and −1.8kN |
| PKPM | 145.1 | 1 | 0 | 5 | Real PKPM/SATWE 2025R2.5; four bases each −10kN, total −40kN; no engine substitution |
| Generic mixed frame + cantilever + brace | 281.2 | 2 | 1 | 9 | 5 nodes / 5 members / 2 loads; all A–E and member IDs preserved; AD area 0.002m²; base Fx/Fz −5/+10kN |

Concrete and PKPM evidence: `phase3/live-final-followup`; final mixed case:
`phase3/live-mixed-final`. Each concrete run has one additional rejected numeric proposal before
the issued confirmation; this is retained in `questionAttempts`/`rejectedQuestions` and included in
the tool count. The confirmed C30 properties, 250×400mm beam sections, 400×400mm columns and all
nine fixed bases were checked in the final models. PKPM has a bound native context with verified
settings/station conventions and hashed native artifacts; base reactions are recovered from native
column-end actions with calibrated fixed-base DOFs. Native availability is demonstrated for this
test, not assumed from an installation probe. A PDB-version warning did not prevent the solve.

An intermediate matched mixed run (`phase3/live-final-followup`, 606.1s / 2 turns / 2 questions /
17 calls) failed because a protocol-valid free-node `restraints: null` was rejected by the draft
normalizer. `735cb0fd` aligns that boundary with the authoritative optional field, preserving strict
array validation; 68 boundary/Agent tests pass. The subsequent `phase3/live-null-followup` run
(382.8s / 2 / 2 / 6) then exposed the unnecessary element-representation confirmation for axial
hinges, resolved by `8f394d5f`. Both failed trials remain in evidence.

Measured comparison: the initial Phase 2 required matrix completed 4/6 with two question groups.
After its empty-case correction, five fully specified cases completed in one turn; the mixed case
completed after one genuinely missing area was supplied. The final Phase 3 matrix likewise completes
5/6 in one turn and all 6/6 after that one supplied area. Matched corrected-matrix tool calls are
56 for Phase 2 versus 43 for Phase 3. The mixed task falls from 22 to 9 calls, and the extra scale
probe uses three compact operations instead of enumerating the generated records. Timings are
individual measurements under differing concurrent workloads, not a statistically established
speedup. **R3.5's strict success-rate and question-count improvement over the already corrected
Phase 2 baseline is not demonstrated**: both now complete 6/6 after clarification and need the same
one real question. No input was made artificially complete and no unknown brace section was invented
to claim a reduction.

## Commit index and integration

- Phase 1, `refactor/skills-settings-phase1`: `acd7992f`, `a395862f`, `47ad9904`,
  `3ff4b41d`, `a518c9b0`.
- Phase 2, `refactor/generic-physics-phase2`: `d6498fea`, `8678ca93`, `75d36ad3`,
  `92c51342`, `3364c1d6`, `2c6953bb`, `b587b1cf`.
- Phase 3, `refactor/generic-operations-phase3`: extraction `d41a61b1`, operations/report
  `65eea060`, tests `d171ee9a`/`9bf5a886`, selector validation `99793fec`, node targets
  `6a804ebc`, host stiffness `0079e9d6`, selector guidance `d74247a2`, explicit force-only
  OpenSees `364328e6`, nullable restraints `735cb0fd`, equivalent axial hinges `8f394d5f`.

The final full Jest, Python, analysis regression, three validators, frontend checks/build and default
E2E have passed. All requested live structure/provider cases have completed with independent checks,
with genuine missing physics supplied through the frontend. The strict R3.5 comparison limitation
above remains explicit. All three phase branches are retained and fast-forward integrated into
`work/research-next` in the primary checkout. A fresh backend compilation was staged separately,
then promoted with the previous dist archived outside the repository; the primary dist-surface
smoke passed all 26 tests (`phase3/primary-dist-surface.log`). The verified Phase 3 frontend export
was promoted only after confirming byte-identical source inputs (four checkout-only line-ending
differences were normalized), and its build fingerprint matches the primary checkout. Previous
frontend output is also archived outside the repository. The primary checkout is clean; benchmark
sources and historical freezes are unchanged. Existing services were not restarted. No push or
scenario-freeze generation was performed.

Early observed scale result: the real LLM chose regular-frame, merge-coincident and nodal-load
operations, preserved A, produced 125 nodes / 260 members / 100 loads and base Fx −10kN. Phase 2
also passed this probe using explicit records (654.1s vs 461.9s observed in Phase 3). These are
individual observations with different concurrent request loads, not a guaranteed speedup.

Each phase records commits, validation summary lines, live timings, user turns, questions,
tool calls, hand checks and evidence paths here when actually observed. No pending item is a pass.

## Generic scope and execution visibility follow-up (2026-10-22)

The user requested both fewer unnecessary generic-route calls and a clear distinction between
allowed skills and skills actually invoked. `4c2515a4` makes a sole generic scope deterministic
in the host and asks the outer agent to extract directly, preserving fixed-route precedence and
genuine engineering-input clarification. It also removes stale provider instructions that required
selecting an analysis skill, and makes the numeric-candidate requirements explicit in the first
clarification call. Numeric provenance checks and analysis gates remain enforced.

`a8f50dce` adds a current-run modelling projection from host extraction/builder events and, for
older ledgers, tool receipts bound to that run's call IDs. An allowed list, stale draft, assistant
claim, or solver invocation is not proof of a modelling-skill invocation. The bilingual composer
shows allowed skills and actual usage separately; routing alone, no invocation, not started, and
unavailable old-server records have distinct states. Runtime details also distinguish the actual
builder from the configured policy. Prompt-debug labels now distinguish routing and providers.

Automatic selection still routes within the allowed scope. Selecting only generic enables the
generic modelling skill; explicitly clearing a restricted selection enables no modelling skills,
not generic. Providers remain independent, so a complete imported model can still be analysed.
A read-only check of the user's two actual earlier conversations identified generic invocation
and the LLM builder in both using their original run ledgers, without inferring usage from selection.

Validation evidence is under `G:/StructureClaw-All/verification/generic-usage-*`:

- Backend build, lint and architecture checks passed (300 modules / 901 dependencies after the axial fix). The focused
  backend set passed 479 tests; prompt/profile checks passed 41 tests / 44 snapshots. The 33 intentional
  snapshot updates concern generic-only workflow instructions, independent providers, prompt hashes
  and the clarification tool description; numerical outputs and policy hashes are unchanged.
- Full Jest covered 3224 tests / 57 snapshots before the axial follow-up: 3223 passed, with one
  attachment test failing because the isolated settings directory lacked its Python path. Adding
  that test-environment setting made all five attachment tests pass on rerun; no application or
  test assertion change was needed for that failure. The original failed log is retained.
- Frontend build, type-check and lint passed. All 334 unit tests passed (6 existing todo cases).
  Integration passed all 83 tests after the remaining prompt-debug assertion was updated for the
  renamed labels. No production change was needed for that assertion.
- Both new Playwright cases passed in English and Chinese: scripted local LLM transport with real
  generic extraction/build tools and real OpenSees, followed by an explicitly empty skill scope and
  complete model import. Eight screenshots cover both locales, both themes and 1440/768px viewports;
  the skill summary does not overflow. This scripted transport proves UI/tool behaviour, not real
  LLM routing quality; the separate real-provider runs below cover that.
- `98d37426` fixes a narrow-screen grid track being expanded by long tool outputs. The final
  browser assertions also require the summary's right edge to stay inside the viewport, rather
  than merely checking overflow inside an already expanded element.
- The three orchestration, chat-stream and analysis contract validators passed.

Fresh real-frontend runs use the saved `glm-5.3` provider in a separate database, frontend copy and
ephemeral port, with credentials supplied only through the process environment. Evidence:
`generic-usage-live`, including per-case original streams, conversation snapshots, models, results,
run ledgers and visible skill-usage labels. The independent checker verifies geometry, connectivity,
supports, section assignments, loads and all six global force/moment equilibrium components.

| Case | Seconds | Turns | Issued questions | Rejected questions | Tool calls | LLM calls | Independently verified outcome |
|---|---:|---:|---:|---:|---:|---:|---|
| Fully specified generic 3D grid | 357.2 | 1 | 0 | 0 | 5 | 7 | 27 nodes / 42 members / 18 actions; base Fx −1.8kN |
| User's delegated-material 3D request | 748.7 | 2 | 1 | 0 | 8 | 11 | Same counts and equilibrium; confirmed C30, 250×500mm beams and 400×400mm columns |
| Mixed frame + cantilever + brace, initial follow-up | 1686.7 | 2 | 1 | 0 | 18 | 29 | 5 nodes / 5 members / 2 actions; A–E preserved, AD area 0.002m², base Fx/Fz −5/+10kN; 3 tool errors / 2 recoveries |
| Mixed structure, fresh axial-fix follow-up | 1104.7 | 2 | 1 | 0 | 8 | 16 | **Failed**: second response exceeded 600s; no completed analysis; 1 tool error / 2 recoveries |

The fully specified grid previously used 7 tool calls; the user's actual generic-only 3D run used
10 tool / 13 LLM calls and one issued confirmation. The new runs use 5 and 8 / 11 respectively;
the real material/section/support confirmation is retained. Both new ledgers route only through
generic without an LLM router, with no recovery or tool error, and the visible usage agrees.
These are individual observations, not a statistically established speedup. The earlier strict
R3.5 success-rate/question-count comparison is not changed by eliminating routing overhead.

The mixed follow-up's 18 calls are worse than the previous corrected 9-call run. Its retained
ledger/log shows an invented section reference, invalid JSON, and two false topology rejections:
`truss` versus `brace`, and omitted redundant rotation-release flags on a pure axial member.
Both names already use the same axial formulation in the physics gate and OpenSees. The follow-up
builder correction therefore restores the authored axial type and rotational-release metadata
before identity validation, only for equivalent axial candidates without offsets. It does not
accept a bending member, discard a translational release, overwrite a changed section/material,
or bypass the physics gate. Genuine modelling errors remain failures. This initial slower trial
is preserved separately from any fresh measurement after that correction. The live harness also
bounds each response to 600 seconds and unloads its own page on timeout to cancel its provider call.

The axial correction is `f7885fb1`; `e2c8e34e` keeps any member with offsets out of this equivalence
normalisation. Its focused set passed 134 tests initially. After the additional offset regression,
the final primary compilation passed all 170 tests in 11 suites, including the compiled surface,
usage projection, routing, builder, operation, stiffness and physics checks. Nine fully specified
physical fixtures include an axial alias with omitted redundant hinges; all require one builder
call, zero recovery, preserved authored metadata and real OpenSees equilibrium. Negative tests
retain rejection of bending, translational-release and offset changes. The three validators,
backend lint and final frontend fingerprint check also passed.

The fresh real-provider follow-up is retained in `generic-usage-live-axial-followup`. It generated
invalid JSON and noncanonical `mx/my/mz` release keys, where the model/solver contract requires
`rx/ry/rz`. These were rejected, not interpreted as successful engineering output. It timed out
on its second response after the same one genuine area clarification; no analysis run completed.
The 8 observed tool calls are an incomplete run and must not be compared as a success or speedup.
This failed measurement is not replaced with another trial. Deterministic equivalence regressions
pass, but general real-LLM stability/latency is **not resolved** and the strict R3.5 improvement is
still not demonstrated. Its `pageErrors` also contains one localStorage SecurityError from the
test's `about:blank` timeout cleanup, not an application-page failure; the locale init script now
skips opaque cleanup origins. The owned live server was shut down after evidence capture.

All code commits were fast-forward integrated into the primary `work/research-next` checkout.
Fresh backend output was compiled in a separate directory before promotion; earlier dist trees
are archived under `verification/generic-usage-primary-dist-before*`. The verified frontend export
was promoted only after checking byte-identical source inputs and a matching build fingerprint;
its predecessor is also archived outside the repository. Existing services were not restarted,
so the running backend needs a restart before it can serve the new projection and routing code.
The UI reports unavailable usage honestly when connected to an older backend. No push, benchmark
change, or historical scenario-freeze regeneration was performed.

## Mixed-structure draft protocol repair (2026-10-22)

The failed axial follow-up exposed a host boundary problem as well as model mistakes: unchecked
`mx/my/mz` release keys entered the draft, deep merge retained them, and later identity checks
protected the malformed dictionary. `897d02ee` validates end releases before draft persistence,
before merging partial member records, and before the generic builder consumes a stored draft.
It translates unambiguous moment/rotation and end aliases to boolean local `i/j.ux/uy/uz/rx/ry/rz`,
preserves false flags and explicit local axes, and rejects unknown fields, unsupported axes and
conflicting definitions. Old and new dictionaries are normalized before deep merge. Complete
imported models retain their ordinary authoritative model-validation boundary.

A malformed old draft produces `DRAFT_PROTOCOL_INVALID` before any model call, with a field-specific
repair path. Clearing that invalid leaf and supplying a corrected representation preserves the
other release flags, geometry, supports, materials, sections and actions. Conflicting aliases
never get an automatic choice or deletion. `53cc79fc` also withholds any clear-field suggestion for
unsupported reference axes. Successful builds persist canonical metadata and keep
the legacy engineering-draft mirror consistent; failures do not adopt an unvalidated candidate.
Topology preservation compares values without depending on object-key order. Axial equivalence
still excludes offsets and translational releases, and all physical/section-provenance gates remain.

Extraction and generic construction request JSON-object mode on the OpenAI-compatible adapter.
`02e4a0e7` also uses the existing low-reasoning GLM-5.3 option for those internal JSON tasks;
native Anthropic handling and ordinary chat options are unchanged. First-extraction field errors
now receive bounded feedback retries using the same recovery ledger as clarification and builder
repairs. Disabling repair prevents those retries. The enclosing cancellation signal reaches the
nested generic call and is checked before another attempt or recovery reservation. This is not
a guarantee against every provider output error or slow response.

`85bdefef` adds legacy replay, atomic rejection, lossless correction, conflict, persistence,
key-order, JSON-option, cancellation and shared-budget regressions. The focused run passed 127
tests, including 11 fully specified fixtures through real OpenSees; the additional extraction-budget
checks passed in a 51-test extraction run. The fixture that first emits an invalid release field
must correct it before persistence, with exactly one shared recovery and no extra user question.
The alias fixture must build once with no recovery and retain authored metadata and equilibrium.

The full backend run at `85bdefef` passed 3248 tests and all 57 snapshots (219 suites). Four suites
failed because the direct Jest command ran from the repository root while those tests resolve
files relative to the backend working directory: two path assertions failed and two suites could
not import CLI modules. Running from `backend/` resolved all four without application or assertion
changes. That rerun also covers the final axis guard and GLM options: 132 tests in nine suites passed.
Both original failure logs and clean rerun logs remain under `G:/StructureClaw-All/verification/draft-release-*`.
Final lint and architecture checks passed (301 modules / 906 dependencies). At `02e4a0e7`, the primary
compilation passed 170 tests in 11 suites, including the compiled surface and all 11 fully specified
OpenSees fixtures. All three orchestration, chat-stream and analysis contract validators passed.

The first fresh real-provider trial with JSON mode but default reasoning is retained in
`draft-release-live`: it **failed** after the first response exceeded 600s (635.7s including cleanup,
one turn, no issued question, two tool calls, five LLM calls, no completed analysis). Extraction
alone used 308.5s and 15696 reasoning tokens; the missing-area builder response used another 148.7s.
No malformed-release error or automatic recovery was recorded, but that is not a successful run.
The GLM reasoning change addresses this separately observed internal-call latency, rather than
claiming the release normalization alone fixed response time. The original axial failure and this
new failed measurement are preserved separately from the subsequent code revision and trial.

The next low-reasoning trial is retained in `draft-release-low-live`: the first turn reached the
one genuine area question in 113.4s, but the full 267.1s run **did not complete analysis**. After
the answer supplied A=0.002m², a stale missing diagnostic for `sectionRecords["S2"].shape` survived.
It caused a second, unnecessary question asking for an equivalent rectangular shape. The trial
used two user turns, two issued questions, six tool calls, nine LLM calls and no tool errors or
automatic recovery. It is not a successful result or an improvement in question count.

The additional correction resolves only a missing whole-shape/dimensions diagnostic when an
evidenced positive area exists, the section has exclusively axial consumers, and no beam/column
assignment or requested design needs that geometry. It preserves explicit conflicts, unknown or
bending consumers, unconfirmed/invalid areas and independent diagnostics. No equivalent rectangle
or bending/torsion properties are invented. The same trial's draft also exposed generated
transverse translation releases on the axial brace. These were already unsupported by the physics
gate; they now fail at extraction before persistence, with feedback explaining that absent shear
stiffness is intrinsic to an axial member. Unsupported stored release conditions receive no
automatic clear-field suggestion. New tests retain rejection of confirmed unsupported conditions.

The focused diagnostic, section/provenance, property-merge, stiffness and release suite passed
455 tests. The new full-flow area fixture then exposed a second route for the same stale field:
an incoming resolved missing issue was reintroduced through its duplicate legacy invalid-field
list. `f5c4259d` makes the legacy list follow both incoming and existing structured diagnostics.
The fixture now reaches real OpenSees with five nodes, five members, two loads and only A=0.002m²
for the brace, with no equivalent geometry and no additional clarification.

The third trial (`draft-release-area-live`) returned an analysis in 162.0s with one user turn,
no questions, six tool calls, eight LLM calls and no recovery/tool error, but **failed independent
input validation**: it assigned the excluded beam/column 200×300mm section to AD (A=0.06m²).
Force/moment equilibrium and a solver success flag do not make that model faithful to the input.
The failed check and original result are retained. `161e734c` restores the provider's original
reasoning setting for first/full extraction and reinforces section inclusion/exclusion scope;
only the model-build and existing short-patch calls request the GLM low-reasoning option. That
guidance is not a proof that every natural-language scope will be interpreted correctly.

Final verification at `161e734c` passed 487 tests in 12 suites in the isolated checkout, including
all 13 fully specified OpenSees cases and the intentional invalid-case correction. The fresh
primary compilation passed 513 tests in 13 suites including the compiled surface. The final
three validators, lint, dependency checks and unchanged frontend build fingerprint all passed.

The final fresh trial at `161e734c` is retained in `draft-release-scope-live` with the same original
prompt and the same free-text area follow-up. It completed in **522.4s**, two user turns and one
genuine area question, with eight tool calls, eleven LLM calls, zero recovery, zero tool error and
zero browser-page error. The first turn reached the area question in 429.4s; extraction keeps its
original reasoning setting, so external-model inference still dominates latency. This is one
successful observation, not a general latency or success-rate guarantee.

The independent checks (`draft-release-scope-live-check.log` and `draft-release-scope-live-final-check.log`)
verify five nodes, five members,
two actions, all A–E / AC–BD–CD–DE–AD identities and connectivity, both fixed supports, 200×300mm
beam/column geometry, AD's user-supplied **A=0.002m²** with no invented equivalent shape, Q235
constants, both signed actions and all six global force/moment balances. Base Fx/Fz are −5/+10kN;
force residuals are below 4e−14kN and moment residuals below 1.2e−13kN·m. Run-ledger routing and
actual invocation contain only generic, its builder is LLM, and the visible usage label agrees.
Earlier incomplete or input-invalid trials are not overwritten or counted as passes.

All implementation/test commits through `161e734c` are fast-forward integrated into primary
`work/research-next`. Fresh backend output was compiled separately and promoted after path and
reparse-point checks; earlier primary outputs are archived as `draft-release-primary-dist-before`
and `draft-release-primary-dist-before-area-scope` under `verification/`. The frontend sources are
unchanged and the existing export fingerprint remains current. The owned trial servers are shut
down; existing user services were never restarted. No push, benchmark change or freeze regeneration
was performed. The newly built backend takes effect when the user next restarts their service.
