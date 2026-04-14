# 通用工具规格

## 概览

StructureClaw 提供 6 个基础层通用工具，用于 agent 运行时的基础设施能力。
这些工具始终通过平台工具目录可用，不需要领域 skill 的显式授权。

每个通用工具在 `backend/src/agent-skills/general/` 下有对应的 skill manifest，
提供编排层的 trigger、阶段约束和工具授权。

## 工具清单

| 工具 ID | 类别 | 层级 | 默认启用 | 安全级别 |
|---------|------|------|---------|---------|
| `memory` | utility | foundation | 是 | read-write-local |
| `planning` | utility | foundation | 是 | read-only |
| `read_file` | utility | foundation | 是 | read-only |
| `write_file` | utility | foundation | 是 | read-write-local |
| `replace` | utility | foundation | 是 | read-write-local |
| `shell` | utility | foundation | 否 | restricted-exec |

## Skill-Tool 映射

| 技能 ID | 域 | 授权工具 | 阶段 |
|---------|------|--------|------|
| `memory` | general | `memory` | intent, draft, analysis, design |
| `planning` | general | `planning` | intent, draft |
| `read-file` | general | `read_file` | intent, draft, analysis |
| `write-file` | general | `write_file` | analysis |
| `replace` | general | `replace` | draft, analysis |
| `shell` | general | `shell` | analysis |

## 安全边界

### 文件沙箱

- 根目录：`.runtime/workspace`
- 最大文件大小：10 MB
- 允许扩展名：`.txt`、`.json`、`.csv`、`.md`、`.py`、`.tcl`、`.log`、
  `.yaml`、`.yml`

### Shell 沙箱

- 允许命令：`python`、`python3`、`opensees`、`OpenSees`
- 禁止命令：`rm`、`del`、`mv`、`cp`、`ln`、`format`、`mkfs`、`sudo`、
  `chmod`
- 最大超时：300 秒
- 最大输出：1 MB

## 架构对齐

这些通用工具遵循 `docs/agent-architecture_CN.md` 中定义的 manifest-first 架构：

- 工具 manifest 位于 `backend/src/agent-tools/{tool_id}/tool.yaml`
- 技能 manifest 位于 `backend/src/agent-skills/general/{skill-id}/skill.yaml`
- 技能通过 `skill.yaml` 中的 `grants` 字段引用对应工具
- `tool-manifest-loader` 发现并校验所有 `tool.yaml` 文件
- `tool-registry` 在运行时解析最终可用工具集合
