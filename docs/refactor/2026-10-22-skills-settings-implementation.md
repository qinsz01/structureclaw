# Skills, providers, settings and generic modelling implementation

Specification: `2026-10-22-skills-tools-settings-spec.md` (all three phases).
Baseline: `70c3c8b1`, `work/research-next`. Benchmark sources and historical freezes are excluded.

## Phase 1 — `refactor/skills-settings-phase1`

Design: structure methods remain skills; configured backends, standards, parsers and exporters
have a separate provider catalog. Legacy capability ids are migrated at the input boundary.
Shared engineering guidance is short, topic-based and controlled by the knowledge policy.
Global defaults live in settings, conversation overrides remain local to their conversation,
and the composer displays the effective scope. Provider disables are explicit settings.

Status: implementation in progress. Acceptance has not yet been established.

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
Observed so far: clean Prisma generation and backend build; backend lint/dependency rules;
1290 Python tests; analysis regression; all three validators; 18 characterization suites / 86
tests; frontend type/lint/production build, 346 unit tests and 83 integration tests. An initial
full clean Jest run exposed obsolete section tests and incomplete test metadata, now corrected
and verified by 23 focused tests. The final full suites and browser/live acceptance remain pending.

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

Pending: R2.1–R2.6, automated suites, scripted characterization, checker tests, generic-only
real-LLM matrix and default-routing regression.

## Phase 3 — shared modelling operations

Pending: R3.1–R3.5, shared deterministic expanders and frame builder consolidation, automated
suites and measured live comparison with phase 2.

Each phase records commits, validation summary lines, live timings, user turns, questions,
tool calls, hand checks and evidence paths here when actually observed. No pending item is a pass.
