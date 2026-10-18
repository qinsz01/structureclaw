# Skill 运行时状态

本文记录 StructureClaw 1.0.0 当前 skill 系统的实现状态。

它是 [agent-architecture_CN.md](./agent-architecture_CN.md) 的补充：架构文档解释 runtime 如何工作，本文跟踪当前代码中哪些 skill domain 是 active、partial、discoverable 或 reserved。

## 当前 Domain 矩阵

状态依据以下来源整理：

- [backend/src/services/agent-capability.ts](../backend/src/services/agent-capability.ts)
- [backend/src/shared/types/agent.ts](../backend/src/shared/types/agent.ts) 中的 `ALL_SKILL_DOMAINS`
- [backend/src/agent-skills](../backend/src/agent-skills) 下的 builtin `skill.yaml`
- 各 skill 目录下可选的 `handler.ts` 与 `runtime.py`

| Domain | 当前代码中的 `runtimeStatus` | Manifest-backed skill 数 | 当前状态 |
|---|---|---:|---|
| `structure-type` | `active` | 8 | 工程主入口 domain。skills 使用 `skill.yaml` + `handler.ts` 完成类型识别、草稿提取、缺失参数提问和模型构建。 |
| `analysis` | `active` | 6 | 已 manifest 化的分析 skills，均有 per-skill `runtime.py`，覆盖 OpenSees、PKPM 和 YJK adapter。 |
| `code-check` | `active` | 4 | 已 manifest 化的设计规范 skills，执行走共享 code-check domain adapter/runtime。 |
| `validation` | `partial` | 1 | structure JSON validation skill；校验走共享 validate 路径。 |
| `report-export` | `partial` | 2 | 已 manifest 化的 report-export skills；PKPM calculation-book skill 包含 Python runtime。 |
| `result-postprocess` | `active` | 1 | 内置 postprocess domain 通过 manifest 元数据参与 artifact flow。 |
| `load-boundary` | `discoverable` | 10 | catalog-visible 的荷载与边界 skills（仅清单与提示内容，无独立 Python 运行时）。 |
| `visualization` | `discoverable` | 1 | catalog-visible 的 visualization prompt 资产，暂无 per-skill runtime 模块。 |
| `section` | `discoverable` | 3 | catalog-visible 的截面 skills，包含 `handler.ts` 和 `runtime.py`；当前不会被主 agent binder 自动激活。 |
| `general` | `discoverable` | 3 | catalog-visible 的通用 skills，覆盖 memory、shell 和 skill 创建；具体运行能力由内置 agent tools 实现。 |
| `data-input` | `discoverable` | 4 | catalog-visible 的 CAD、CSV/Excel、图片与 PDF 输入 skills；文件由 `analyze_file` 读取（DXF 经 CAD skill 的 `dxf_worker.py`）。 |
| `design` | `reserved` | 0 | taxonomy 槽位，当前没有内置 skill。 |
| `drawing` | `reserved` | 0 | taxonomy 槽位，当前没有内置 skill。 |
| `material` | `reserved` | 0 | taxonomy 槽位，当前没有内置 skill。 |

## 关键说明

- domain 出现在 taxonomy 中，并不代表它已经参与主执行路径。
- manifest-backed skill 表示可发现；是否可执行取决于所在 domain，以及是否存在 `handler.ts`、`runtime.py` 或共享 domain adapter。
- runtime status 由代码计算。在 `agent-capability.ts` 中，`structure-type`、`analysis`、`code-check`、`result-postprocess` 在可发现时为 active；`validation`、`report-export`、`design` 在可发现时为 partial；其他有 manifest 的 domains 为 discoverable。

## 资产快照

| Domain | 资产情况 |
|---|---|
| `analysis` | 6 个 skills，均包含 `skill.yaml` + `intent.md` + 独立 `runtime.py` |
| `code-check` | 4 个 skills，均包含 `skill.yaml` + `intent.md` + `code_check.py`；执行走共享 code-check runtime |
| `structure-type` | 8 个 skills，均包含 `skill.yaml` + `intent.md` + `handler.ts`；其中 7 个（`generic` 除外）还有 `draft.md`，作为参数提取的草稿阶段说明 |
| `validation` | 1 个 skill，包含 `skill.yaml` + `intent.md` |
| `report-export` | 2 个 skills；PKPM calculation-book skill 包含 `intent.md` + `runtime.py` |
| `result-postprocess` | 1 个 skill，包含 `skill.yaml` + `intent.md` |
| `load-boundary` | 10 个 skills，均有 `skill.yaml`；其中 9 个还有 `intent.md` |
| `visualization` | 1 个 skill，包含 `skill.yaml` + `intent.md` |
| `section` | 3 个 skills，均包含 `skill.yaml` + `intent.md` + `handler.ts` + `runtime.py` |
| `general` | 3 个 skills，均包含 `skill.yaml`；memory 有 `intent.md`，skill-creation 有 `intent.md` + `draft.md` |
| `data-input` | 4 个 skills，均包含 `skill.yaml` + `intent.md`；CAD 还有 `dxf_worker.py` |

## 维护规则

1. 新增、删除或移动 `skill.yaml` 时，同步更新本文。
2. runtime-status 表述必须和 [backend/src/services/agent-capability.ts](../backend/src/services/agent-capability.ts) 保持一致。
3. 不要在代码暴露 discoverable skill 或 runtime 行为之前，把 reserved domain 写成已实现。
