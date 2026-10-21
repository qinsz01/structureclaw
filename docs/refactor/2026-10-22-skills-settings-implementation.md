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

Verified so far: six scripted-LLM graph cases reach real OpenSees and satisfy independent support
equilibrium (2-storey frame, portal, arch, inclined truss, 3D grid, frame+brace). Physics/completion/
repair and canonical-boundary focused tests pass; frontend production build and 1290 Python tests
pass. The first full run found an incomplete worktree Python environment and obsolete generic
expectations, plus real mirror/name/readiness regressions now fixed and under final regression.
The generic-only real-LLM matrix is running, with the saved server policy checked as `['generic']`.
Full suites, default-route live regression and final acceptance table remain pending.

## Phase 3 — shared modelling operations

Pending: R3.1–R3.5, shared deterministic expanders and frame builder consolidation, automated
suites and measured live comparison with phase 2.

Each phase records commits, validation summary lines, live timings, user turns, questions,
tool calls, hand checks and evidence paths here when actually observed. No pending item is a pass.
