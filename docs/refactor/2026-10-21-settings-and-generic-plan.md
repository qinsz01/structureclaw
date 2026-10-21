# Plan: unified settings and a capable generic skill (2026-10-21)

Evidence: read-only audits of the frontend settings surfaces and of `agent-skills/structure-type/generic`
(2026-10-21). No benchmark-specific adjustments: every change must make sense for a real user.

## Part 1 — Unified settings

### Problems found
1. Opening a conversation copies its active skills/tools into the *global* capability preference
   with `explicit=true` (`conversation-selection.ts:94`, `use-capability-catalog.ts:70`); new
   conversations inherit whatever was last opened (likely cause of the beam-only frame session).
2. The capability panel's conversation picker only changes the readiness view; toggles still write
   the global store (`capability-settings-panel.tsx:129,191`).
3. The tool-call limit is editable in three places (General `agent.maxToolCallsPerTurn`, hidden
   `agent.runPolicy.budgets`, Run settings) with silent clamping (`run-policy.ts:155,160`).
4. `settings.agent.runPolicy` has no UI yet silently caps skills/tools/memory.
5. Run settings claim "saved to this conversation" but reopen empty (`use-console-state.ts:47`).
6. Same panels reachable as pages and dialog tabs (`/capabilities`, `/llm`); `/database` is a
   read-only status page; the narrowed-scope notice renders twice; run-settings strings bypass i18n;
   two overlapping Python paths; theme/locale outside settings; input-review dialog always sends
   the global scope (`console-dialogs.tsx:101`).

### Target
- **One settings dialog**, sections: Model (LLM, vision) · Analysis engines & environment (Python,
  OpenSees, PKPM, YJK) · Capabilities · Run policy defaults · Appearance (theme, locale, layout) ·
  Data (database status). `/capabilities`, `/llm`, `/database` become deep links into the dialog.
- **Three explicit scopes, each edited in exactly one place:**
  - *Global defaults* (dialog): capabilities default, run-policy defaults incl. tool-call limit
    (the single source; server ceiling shown, not silently clamped), engines, LLM.
  - *This conversation* (conversation header/run settings): an optional override of capabilities
    and run policy, shown when the conversation is opened, persisted with the conversation.
  - *This turn*: nothing hidden; the composer only displays the effective scope.
- Opening or switching conversations never writes global preferences. Input review uses the
  conversation's effective scope.
- `settings.agent.runPolicy` is surfaced as "Run policy defaults"; its caps are visible.
- One narrowed-scope notice; all strings through i18n; one analysis Python path (YJK keeps its own
  SDK interpreter only if technically required, labelled as such).

## Part 2 — A generic skill with real general ability

### Findings
- Generic-only in the paper: 22.0 % E2E vs 82.9 % auto; every scenario with vertical members scored
  0 (frames, portals, columns). Dominant causes: member role typing (columns typed as `beam`),
  missing stories, section/material metadata, one-shot JSON for large grids, hand-distributed loads,
  no stability or load-total checks.
- Generic still carries beam/frame template leftovers in ingestion (`ingestGenericDraft` collapses
  multiple loads to the first one, projects beam/frame scalars, `normalizeFrameBoundary`) and lists
  specialised `structuralTypeKeys` in `skill.yaml`.
- The builder prompt lacks modelling conventions and the section-evidence / load-direction rules;
  generic misses placeholder stiffness for force-only requests and grade-based material completion;
  no deterministic post-build physics checks; one retry only.

### Target design
Generic = free-form modeller that (a) reuses the deterministic generators the specialised skills
already have, (b) lets the LLM decide *what* to build, and (c) verifies physics deterministically.

| Priority | Change |
|---|---|
| P1 | Remove template leftovers from generic ingestion and `skill.yaml`; keep canonical `engineeringDraft` + user text; multiple loads preserved. |
| P1 | Builder prompt: principle-level modelling conventions (member roles beam/column/truss/brace, stories, section purpose, releases, local axis, units, supports) + section-evidence and load-direction rules. |
| P1 | Shared completion: force-only → placeholder stiffness; known grades → material constants (same code paths as templates). |
| P1 | Deterministic post-build checker feeding repair: disconnected/orphan nodes, mechanisms/rigid-body modes, zero-length/duplicate members, vertical members typed as beams, load totals vs request. Retry budget under run policy (default 2). |
| P2 | Modelling operations the LLM can call, backed by shared deterministic expanders extracted from the specialised builders: regular grid/frame, truss panels, polyline/arc, replicate/mirror/translate, merge coincident nodes, member UDL/point loads, floor-to-beam loads, property assignment by selector, connectivity/stability check. |
| P2 | Partial user topology: complete with the LLM while preserving user IDs. |
| P2 | Generic readiness = physics checklist (geometry closed, supports, loads targeted, properties or force-only). |
| P3 | Generic report narrative (supports, load totals, governing results); merge duplicated frame builders; scripted generic characterization fixtures (frame, portal, arch, inclined truss, 3D grid). |

Coexistence: automatic routing still prefers a specialised skill when it fits; generic handles the
rest. Because both use the same generators, results converge.

Ablation note: `generic-only` and `no-template-builder` results will change; experiments use a new
profile version and a new freeze. Physical capability is in scope; benchmark-only format
conventions are not.
