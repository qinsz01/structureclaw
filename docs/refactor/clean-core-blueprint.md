# Clean-core refactor blueprint (2026-10-17)

Branch `refactor/clean-core`, baseline tag `pre-refactor-20261017`. Behaviour-preserving
except for explicitly listed items. Each step lands with build + lint + full Jest +
full pytest + characterization suite green.

## Fixed constraints

- Tool names, tool argument schemas, `/api/v1/chat/stream`, `/stream/resume`, session
  snapshot and run-record shapes stay stable.
- `backend/dist` paths consumed by `tests/llm-benchmark/runner.cjs`
  (`agent-runtime/index.js`: `AgentSkillRuntime.listSkillManifests`;
  `agent-langgraph/agent-service.js`: `LangGraphAgentService` ctor, static `getProtocol`,
  `runStream`, `resumeStream`, `runFull`, `getConversationSessionSnapshot`), the OpenClaw
  plugin (`agent-langgraph/{tool-registry,attachment-vision,public-tool-contracts}.js`)
  and `tests/regression/backend-validations.js` stay importable (re-export shims allowed).
  Guarded by `backend/tests/dist-surface.test.mjs`.
- Default-policy system prompt and skill stage markdown stay byte-identical; default
  `policyHash` unchanged (new policy fields omitted from the hash body at default).
- The benchmark submodule is not modified. Solver per scenario is fixed by the task.
  OpenSees is required (no simplified fallback solver).
- The 2026-10-13 scenario freeze manifest is already stale; a new freeze is produced
  after the refactor.

## Target layering (enforced by dependency-cruiser, `npm run check:deps`)

```
L0 shared       shared/locale.ts, shared/types/*
L1 kernel       runtime/ (run-policy, run-context, ablation-profiles, limits), config/, utils/
L2 domain       engineering/, skill-shared/, agent-skills/*
L3 agent-core   agent-runtime/
L4 services     services/
L5 agent-host   agent-langgraph/ (tools/, graph, agent-service, delivery/, policy-resolver)
L6 delivery     api/, index.ts
```

Lower layers never import higher ones; no cycles.

## Steps

| # | Step |
|---|------|
| 1 | Characterization suite (`backend/tests/characterization`), dist-surface test, prompt/hash snapshots |
| 2 | Delete dead code: `agent-runtime/{patch-reducer,artifact-helpers,load-boundary-types}.ts`, `services/{agent-policy,agent-pipeline-state}.ts`, `AgentSkillRuntime.extractDraftParameters`, `detectRequestedAnalysisSkillId`, `validation/structure-json/runtime.py`, abandoned load-boundary Python |
| 3 | `shared/locale.ts`, `runtime/limits.ts` (single 200 tool-call default), `runtime/run-policy-schema.ts`; dep-cruiser at warn |
| 4 | Break file cycles (input-evidence↔model-state, graph↔system-prompt, the former section-catalog 3-cycle); move `policy-settings` to host layer |
| 5 | `shared/types`, coordinate-semantics/member-response into `engineering/` with shims; dep-cruiser at error. The section catalogue moved with them was later removed (`dbc164d`): designations no longer select catalogue data |
| 6 | Engine catalog `agent-skills/analysis/catalog.ts` + TS/manifest parity test |
| 7 | Split `tools.ts` into `agent-langgraph/tools/*` (barrel keeps exports) |
| 8 | Split `agent-service.ts` (attachments/ground-motion, initial-message, session/snapshot) |
| 9 | `api/chat.ts` persistence → `services/chat-persistence.ts`, shared SSE session; graph final-answer overrides → `delivery/final-answer.ts` |
| 10 | Single Draft: `agent-runtime/draft/boundary.ts` (`ingestDraft`, `projectDraftState`), remove legacy aliases/mirrors |
| 11 | Single `EffectiveRunPolicy` per turn; remove `configurable` mutation |
| 12 | Ablation profiles (below) |
| 13 | Retire compatibility wrappers, docs, live acceptance (OpenSees/PKPM/YJK, en/zh), new freeze |

## Ablation profiles (`runtime/ablation-profiles.ts`)

Selection precedence: request `context.runPolicy` > `SCLAW_RUN_PROFILE` env (benchmark
exception to the infrastructure-only env rule) > `settings.agent.runPolicy` > default.
Profile id + effective policy hash are recorded in the run-record, `LangGraphRunResult`
and the session snapshot. Disabling a mechanism removes only that mechanism; tools,
interfaces and solver stay identical and the agent still ends the turn with an answer.

| Profile | Policy | Capability removed |
|---|---|---|
| `full` | `{}` | — |
| `generic-only` | `skillIds` = generic + non-structure-type skills | specialist structure skills (paper v2 bundle) |
| `no-routing` | `routing: fixed generic` | automatic skill selection |
| `no-knowledge` | `knowledge: disabled` | skill descriptions / stage markdown in prompts |
| `no-template-builder` | `builder: llm` | template model builders |
| `no-validation-gate` | `features.validation: disabled` | `validate_model` tool + prompt step (normalization and solver checks stay) |
| `no-clarification` | `features.clarification: disabled` | clarification interrupt tool + prompt instructions (agent lists missing inputs instead) |
| `no-state-versioning` | `features.stateVersioning: off` | stale-result invalidation after edits (hashes still recorded) |
| `no-evidence-binding` | `features.evidenceBinding: off` | report ↔ model/run/combination provenance checks |
| `no-repair` | `repair.enabled: false` + recovery prompt text | LLM correction retries (semantic rule fallback removed) |

Design references: paper appendix A5 ("matched component ablations") and the
2026-10-12 bench review protocol (same solver, budget, interface and inputs; capability
loss must not be reported as an interface break).
