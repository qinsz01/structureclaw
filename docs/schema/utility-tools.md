# Utility Tools Specification

## Overview

StructureClaw provides 6 foundation-tier utility tools for infrastructure
capabilities. These tools are always available via the platform tool catalog and
do not require domain-specific skill authorization.

Each utility tool has a matching skill manifest under `backend/src/agent-skills/general/`
that provides the orchestration layer (triggers, stage constraints, grants).

## Tool Inventory

| Tool ID | Category | Tier | Default | Safety |
|---------|----------|------|---------|--------|
| `memory` | utility | foundation | enabled | read-write-local |
| `planning` | utility | foundation | enabled | read-only |
| `read_file` | utility | foundation | enabled | read-only |
| `write_file` | utility | foundation | enabled | read-write-local |
| `replace` | utility | foundation | enabled | read-write-local |
| `shell` | utility | foundation | disabled | restricted-exec |

## Skill-Tool Mapping

| Skill ID | Domain | Grants | Stages |
|----------|--------|--------|--------|
| `memory` | general | `memory` | intent, draft, analysis, design |
| `planning` | general | `planning` | intent, draft |
| `read-file` | general | `read_file` | intent, draft, analysis |
| `write-file` | general | `write_file` | analysis |
| `replace` | general | `replace` | draft, analysis |
| `shell` | general | `shell` | analysis |

## Safety Boundaries

### File Sandbox

- Root directory: `.runtime/workspace`
- Max file size: 10 MB
- Allowed extensions: `.txt`, `.json`, `.csv`, `.md`, `.py`, `.tcl`, `.log`,
  `.yaml`, `.yml`

### Shell Sandbox

- Allowed commands: `python`, `python3`, `opensees`, `OpenSees`
- Denied commands: `rm`, `del`, `mv`, `cp`, `ln`, `format`, `mkfs`, `sudo`,
  `chmod`
- Max timeout: 300 seconds
- Max output: 1 MB

## Architecture Alignment

These utility tools follow the manifest-first architecture defined in
`docs/agent-architecture.md`:

- Tool manifests live in `backend/src/agent-tools/{tool_id}/tool.yaml`
- Skill manifests live in `backend/src/agent-skills/general/{skill-id}/skill.yaml`
- Skills reference tools via the `grants` field in `skill.yaml`
- The `tool-manifest-loader` discovers and validates all `tool.yaml` files
- The `tool-registry` resolves the final available tool set at runtime
