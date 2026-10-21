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

Pending: R3.1–R3.5, shared deterministic expanders and frame builder consolidation, automated
suites and measured live comparison with phase 2.

Each phase records commits, validation summary lines, live timings, user turns, questions,
tool calls, hand checks and evidence paths here when actually observed. No pending item is a pass.
