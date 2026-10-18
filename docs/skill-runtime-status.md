# Skill Runtime Status

This document records the current StructureClaw 1.0.0 implementation state for the skill system.

It complements [agent-architecture.md](./agent-architecture.md): the architecture document explains how the runtime works, while this file tracks which skill domains are active, partially wired, discoverable, or reserved in the current codebase.

## Current Domain Matrix

Status is derived from:

- [backend/src/services/agent-capability.ts](../backend/src/services/agent-capability.ts)
- `ALL_SKILL_DOMAINS` in [backend/src/shared/types/agent.ts](../backend/src/shared/types/agent.ts)
- builtin `skill.yaml` files under [backend/src/agent-skills](../backend/src/agent-skills)
- optional `handler.ts` and `runtime.py` files under each skill directory

| Domain | `runtimeStatus` in current code | Manifest-backed skills | Current state |
|---|---|---:|---|
| `structure-type` | `active` | 8 | Main engineering entry domain. Skills use `skill.yaml` + `handler.ts` for detection, draft extraction, missing-field questions, and model building. |
| `analysis` | `active` | 6 | Manifest-backed analysis skills with per-skill `runtime.py` adapters for OpenSees, PKPM, and YJK. |
| `code-check` | `active` | 4 | Manifest-backed design-code skills. Execution goes through shared code-check domain adapters/runtime. |
| `validation` | `partial` | 1 | Structure JSON validation skill; validation runs through the shared validate path. |
| `report-export` | `partial` | 2 | Manifest-backed report-export skills; the PKPM calculation-book skill includes a Python runtime. |
| `result-postprocess` | `active` | 1 | Built-in postprocess domain participates in the artifact flow through manifest metadata. |
| `load-boundary` | `discoverable` | 10 | Catalog-visible load and boundary skills (manifest + prompt assets only; no per-skill Python runtime). |
| `visualization` | `discoverable` | 1 | Catalog-visible visualization prompt asset without a per-skill runtime module. |
| `section` | `discoverable` | 3 | Catalog-visible section skills with `handler.ts` and `runtime.py`; they are not auto-activated by the main agent binder. |
| `general` | `discoverable` | 3 | Catalog-visible general skills for memory, shell and skill creation; concrete runtime behavior is implemented by built-in agent tools. |
| `data-input` | `discoverable` | 4 | Catalog-visible CAD, CSV/Excel, image and PDF input skills; files are read by `analyze_file` (DXF through the CAD skill's `dxf_worker.py`). |
| `design` | `reserved` | 0 | Taxonomy slot with no current built-in skill. |
| `drawing` | `reserved` | 0 | Taxonomy slot with no current built-in skill. |
| `material` | `reserved` | 0 | Taxonomy slot with no current built-in skill. |

## Important Caveats

- A domain being present in the taxonomy does not mean it participates in the main execution path.
- A manifest-backed skill is discoverable, but executable behavior depends on the domain and whether `handler.ts`, `runtime.py`, or shared domain adapters are wired.
- Runtime status is computed from code. In `agent-capability.ts`, `structure-type`, `analysis`, `code-check`, and `result-postprocess` are active when discoverable; `validation`, `report-export`, and `design` can be partial when discoverable; other domains with manifests are discoverable.

## Asset Snapshot

| Domain | Asset note |
|---|---|
| `analysis` | 6 skills with `skill.yaml` + `intent.md` + per-skill `runtime.py` |
| `code-check` | 4 skills with `skill.yaml` + `intent.md` + `code_check.py`; execution uses the shared code-check runtime |
| `structure-type` | 8 skills with `skill.yaml` + `intent.md` + `handler.ts`; 7 also include `draft.md` (not `generic`), which is the extractor's draft-stage guidance |
| `validation` | 1 skill with `skill.yaml` + `intent.md` |
| `report-export` | 2 skills; the PKPM calculation-book skill includes `intent.md` + `runtime.py` |
| `result-postprocess` | 1 skill with `skill.yaml` + `intent.md` |
| `load-boundary` | 10 skills with `skill.yaml`; 9 also include `intent.md` |
| `visualization` | 1 skill with `skill.yaml` + `intent.md` |
| `section` | 3 skills with `skill.yaml` + `intent.md` + `handler.ts` + `runtime.py` |
| `general` | 3 skills with `skill.yaml`; memory has `intent.md`, skill-creation has `intent.md` + `draft.md` |
| `data-input` | 4 skills with `skill.yaml` + `intent.md`; CAD also has `dxf_worker.py` |

## Maintenance Rules

1. Update this file whenever `skill.yaml` files are added, removed, or moved.
2. Keep the runtime-status wording aligned with [backend/src/services/agent-capability.ts](../backend/src/services/agent-capability.ts).
3. Do not describe reserved domains as implemented until the code exposes discoverable skills or runtime behavior for them.
