# Ablation profiles

[中文](ablation_CN.md)

StructureClaw ships pre-registered, versioned ablation profiles so a benchmark can run matched
component ablations without any benchmark code change. Each profile keeps the same solver, budgets,
tool interfaces and inputs and removes exactly one mechanism. Removing a mechanism is a capability
loss, not a broken interface: the agent still finishes the turn with an answer.

Source of truth: `backend/src/runtime/ablation-profiles.ts` (`ABLATION_PROFILES_VERSION`, currently
`2026-10-21.7`). Any change to a profile definition, or to the default prompts or tools that every profile
shares, requires a new version. History:

- `2026-10-17.1`: initial profiles. `2026-10-17.2`: `no-knowledge` also removes stage names.
- `2026-10-18.1`: the default workflow stops before code checks; missing design inputs are reported, not asked for.
- `2026-10-18.2`: force-only requests need no material or section; reports only on request; code checks look up code-determined values.
- `2026-10-18.3`: one report rule (a report only when the user asks for a report, calculation book or other deliverable document); the seismic check and report follow the request.
- `2026-10-19.1`: the equilibrium shortcut is removed (`run_analysis` `method=equilibrium`/`allowPartial`, `requestScope.method`); the default prompts drop duplicated rules, and the structure-type draft guidance no longer proposes default grades or sections.
- `2026-10-19.2`–`2026-10-20.8`: explicit section properties win over geometry (rounding accepted); recalled table values need user confirmation and user-sourced section numbers need evidence; compact clarification patches; global result coordinates; fillets approximated as sharp corners.
- `2026-10-21.1`: section evidence accepts reviewed attachments, confirmed candidates and rule-derived values; stated load-sign conventions are honoured; structural routing is LLM-first; silently enabled analysis defaults are off unless stated; declared source frames are mapped to global Z-up; clarification replies may carry attachments.

- `2026-10-21.5`: disclose excluded structure skills, repair frame-base draft mapping and focused extraction guidance, stop unresolved applied answers, and clarify model import errors.
- `2026-10-21.6`: preserve scoped router prompts; enforce capability notices at clarification/final delivery, preserve per-node frame loads in guidance, and detect frame alias mapping faults. Only an applied answer to a previously missing field can trigger the mapping-fault guard.
- `2026-10-21.7`: publish fixed-base defaults in the existing bilingual assumption format consumed by tool delivery.

## Selecting a profile

| Source | How | Rank |
|---|---|---|
| Request | `context.runPolicy.profile` on `/api/v1/chat/stream`, `/api/v1/agent/run` or a public-tool session | highest |
| Environment | `SCLAW_RUN_PROFILE=<id>` on the backend process (or the process that imports `backend/dist`) | |
| Settings | `settings.json` → `agent.runPolicy.profile` | |
| Default | none (full system) | lowest |

Full precedence, low to high: default < settings profile < settings `agent.runPolicy` fields <
`SCLAW_RUN_PROFILE` < the conversation's saved policy (earlier turns) < request profile < legacy
request fields (`context.skillIds`, `enabledToolIds`, `disabledToolIds`) < request
`context.runPolicy` fields. Explicit fields override profile fields, e.g.
`{ "profile": "no-clarification", "features": { "clarification": "enabled" } }` keeps clarification.

Every profile fully specifies the mechanism fields (`knowledge`, `builder`, `routing`, `skillIds`,
`repair.enabled`, `features`), so selecting a profile later in a conversation never inherits another
profile's ablation. A conversation keeps its saved policy across turns: start a new conversation (or
request a profile explicitly) when the environment profile changes.

Unknown ids fail fast with a bilingual `UNKNOWN_RUN_PROFILE` error: at request validation (the
request is rejected before any model call), at settings load, and at backend startup for
`SCLAW_RUN_PROFILE`.

`GET /api/v1/agent/run-profiles` lists `{ version, envProfile, profiles[] }`, each profile with its
policy preset, bilingual `removes` text and targeted capability groups.

### `SCLAW_RUN_PROFILE` exception

Runtime configuration normally lives only in `settings.json`; environment variables are reserved for
infrastructure (`SCLAW_DATA_DIR`, `NODE_ENV`). `SCLAW_RUN_PROFILE` is the single deliberate exception
so that an unmodified benchmark runner can be pointed at an ablation by its launcher. It only selects
one of the pre-registered profiles; it cannot express arbitrary policy.

## Profiles

Capability groups follow the 2026-10-12 bench review: **A** model construction fidelity, **B** result
interpretation, **C** capability boundaries and missing input, **D** state revision and versioning,
**E** evidence and report provenance, **F** constrained candidate selection.

| Profile | Policy | Removes | Groups |
|---|---|---|---|
| `full` | defaults | nothing (reference); policy hash equals the default hash | — |
| `generic-only` | `skillIds` = every skill except structure-type skills other than `generic` (a skill ceiling) | specialist structure skills; analysis, code-check, report and other domains stay | A, B |
| `no-routing` | `routing: { mode: fixed, skillId: generic }` | automatic structure-skill selection (the structural router is not called) | A |
| `no-knowledge` | `knowledge: disabled` | skill descriptions, triggers, stage names and stage markdown in the agent, structural-router and parameter-extractor prompts | A, C |
| `no-template-builder` | `builder: llm` | deterministic template model builders; `build_model` uses the LLM model builder | A |
| `no-validation-gate` | `features.validation: disabled` | the `validate_model` tool and its workflow step; model normalization and solver checks stay | A, C |
| `no-clarification` | `features.clarification: disabled` | the `ask_user_clarification` interrupt and its prompt instructions; the agent lists missing inputs in its final reply | C |
| `no-state-versioning` | `features.stateVersioning: off` | stale-result invalidation after model, draft, evidence or settings changes; revisions, history and hashes are still recorded | D, F |
| `no-evidence-binding` | `features.evidenceBinding: off` | report ↔ model/run/code-check provenance checks | E, D |
| `no-repair` | `repair.enabled: false` | automatic rule fallbacks and recoveries, plus the recovery-encouraging prompt text | C, D |

### What each switch does at runtime

- **generic-only**: the profile acts as a ceiling, so explicit or legacy skill lists (for example
  the benchmark's `context.skillIds`) are intersected with it; denied ids appear in
  `deniedSkillIds`. Equivalent to the benchmark runner's own `generic-only` mode for structure
  skills.
- **no-routing**: `detect_structure_type` / `extract_draft_params` return `routingSource:
  policy-fixed` with `skillId: generic`. Combine with a skill scope that contains `generic`;
  otherwise the turn fails with `FIXED_SKILL_OUTSIDE_SCOPE`.
- **no-knowledge**: skill names, ids and domains stay visible; descriptions, triggers, stage names
  (`stages=` in the agent prompt, `stages` in the extractor prompt) and stage markdown are removed.
- **no-validation-gate** / **no-clarification**: the tool is removed from exposure (its schema is
  unchanged and a direct call is refused with `TOOL_NOT_ALLOWED`). The system prompt is rewritten
  consistently. The same prompt consistency applies whenever the tool is unavailable for another
  reason (for example `tools.disabledIds`). With clarification disabled, every tool that would
  return `nextAction: "ask_user_clarification"` returns `nextAction: "report_missing_inputs"`
  instead.
- **no-state-versioning**: edits commit new revisions and history entries as usual, but saved
  analysis, code-check and report results remain current; `currentAnalysisError` ignores
  revision/hash mismatches (unresolved input evidence still blocks).
- **no-evidence-binding**: `generate_report` pairs the session's current model and code-check with
  the selected run without verifying they belong together, skips `REPORT_MODEL_MISMATCH` and
  `REPORT_DESIGN_RUN_MISMATCH`, and the report JSON carries `meta.evidenceBinding: "off"`. The HTTP
  `/api/v1/analysis` report endpoint (outside agent runs) keeps its checks.
- **no-repair**: after a failure in a turn, model/settings/solver tools are refused with
  `RECOVERY_BUDGET_EXHAUSTED`; read-only inspection stays available and the agent reports the error.
  Guards still apply (agent-architecture.md, "Guard layer"): the final-answer integrity check flags
  without a correction request, and the first guard rejection ends the turn.

## Recorded fields

Recorded wherever the run policy is already recorded — the run-record ledger
(`<data>/run-records/<runId>.json`), `LangGraphRunResult.runPolicy` and the session snapshot
`policy`; no stream fields are added:

- `profileId` — present whenever a profile was selected (including `full`);
- `features` — present only when a feature is not at its default;
- `profileOverrides` — mechanism field paths (`knowledge`, `builder`, `routing`, `repair.enabled`,
  `features.*`) whose effective value differs from the selected profile's preset, e.g. turn 1
  `{ "profile": "no-knowledge" }` then turn 2 `{ "knowledge": "enabled" }` gives
  `profileOverrides: ["knowledge"]`. Recomputed every turn and omitted when empty. Skill lists only
  narrow the scope (`generic-only` is enforced as a ceiling), so they are not reported;
- `policyHash` — `profileId` (except `full`), non-default `features` and a non-empty
  `profileOverrides` are part of the hash body,
  so the default and `full` hashes are identical to the pre-profile hash;
- `fieldSources` — per field: `default`, `settings`, `env`, `session`, `legacy`, `request` or
  `server-limit`; `fieldSources.profileId` tells where the profile came from.

## Example

```bash
SCLAW_RUN_PROFILE=no-clarification node tests/runner.mjs llm-benchmark --scenario <id>
```

```json
{ "message": "...", "context": { "locale": "en", "runPolicy": { "profile": "no-knowledge" } } }
```
