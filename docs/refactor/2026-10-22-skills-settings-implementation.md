# Skills, providers, settings and generic modelling implementation

Specification: `2026-10-22-skills-tools-settings-spec.md` (all three phases).
Baseline: `70c3c8b1`, `work/research-next`. Benchmark sources and historical freezes are excluded.

## Phase 1 — `refactor/skills-settings-phase1`

Design: structure methods remain skills; configured backends, standards, parsers and exporters
have a separate provider catalog. Legacy capability ids are migrated at the input boundary.
Shared engineering guidance is short, topic-based and controlled by the knowledge policy.
Global defaults live in settings, conversation overrides remain local to their conversation,
and the composer displays the effective scope. Provider disables are explicit settings.

Status: implementation delivered; automated acceptance passed. Live acceptance exposed the
remaining modelling issues below, so full phase acceptance has not yet been established.

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

Verified so far: 1292 Python tests; 327 frontend unit / 83 integration tests; frontend type/lint and
production build; backend build/lint/dependency rules; analysis regression and three validators.
Default browser E2E: 54 passed / 12 live-only skipped in 30.1 minutes (`phase3/e2e.log`).
Operation tests: 14 pass, including real slab solves and bounded failure with the saved model intact.
The first full Jest attempt found one intentionally changed old readiness expectation, now explicitly
documented and passing in all 57 compatibility tests. Concurrent compilation also interfered with
eight Jest module imports. Another invocation used the repository rather than backend working
directory and failed four path-sensitive suites; their source was not changed to hide that setup
error. The final full run uses the backend directory and a fixed compiled tree
(`phase3/backend-final-success.log`). Final full Jest remains pending; the live follow-ups below
have completed. Earlier interrupted runs were stopped when new real-input defects required a
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
The mixed case and original concrete/PKPM requests are being remeasured after the stiffness and
node-selector corrections; the completed follow-ups are separated below and initial failures stay
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

## Commit index and remaining verification

- Phase 1, `refactor/skills-settings-phase1`: `acd7992f`, `a395862f`, `47ad9904`,
  `3ff4b41d`, `a518c9b0`.
- Phase 2, `refactor/generic-physics-phase2`: `d6498fea`, `8678ca93`, `75d36ad3`,
  `92c51342`, `3364c1d6`, `2c6953bb`, `b587b1cf`.
- Phase 3, `refactor/generic-operations-phase3`: extraction `d41a61b1`, operations/report
  `65eea060`, tests `d171ee9a`/`9bf5a886`, selector validation `99793fec`, node targets
  `6a804ebc`, host stiffness `0079e9d6`, selector guidance `d74247a2`, explicit force-only
  OpenSees `364328e6`, nullable restraints `735cb0fd`, equivalent axial hinges `8f394d5f`.

Pending before integration: final full Jest, clean final compilation in the primary checkout, and
the final clean-tree/benchmark exclusion check. No push or scenario-freeze generation is requested.

Early observed scale result: the real LLM chose regular-frame, merge-coincident and nodal-load
operations, preserved A, produced 125 nodes / 260 members / 100 loads and base Fx −10kN. Phase 2
also passed this probe using explicit records (654.1s vs 461.9s observed in Phase 3). These are
individual observations with different concurrent request loads, not a guaranteed speedup.

Each phase records commits, validation summary lines, live timings, user turns, questions,
tool calls, hand checks and evidence paths here when actually observed. No pending item is a pass.
