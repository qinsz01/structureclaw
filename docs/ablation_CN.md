# 消融运行配置档

[English](ablation.md)

StructureClaw 提供预先注册、带版本号的消融配置档，基准测试无需修改任何评测代码即可执行配对的组件消融。
每个配置档保持相同的求解器、预算、工具接口和输入，只移除一项机制。移除机制意味着能力损失，而不是接口损坏：
代理仍然以一条回答结束本轮。

唯一来源：`backend/src/runtime/ablation-profiles.ts`（`ABLATION_PROFILES_VERSION`，当前为
`2026-10-18.3`；`.2` 起 `no-knowledge` 同时移除阶段名称；`2026-10-18.1` 修改了所有配置档的默认提示词：
分析并生成报告后停止，规范校核仅在明确要求时执行，缺少设计输入时报告而不追问；`2026-10-18.2` 再次修改：
只求内力时不需要材料截面，报告仅在要求时生成，规范校核自动查取规范确定的数值；`2026-10-18.3` 将报告规则统一为一条原则——
仅在用户要求报告、计算书或其他交付文件时生成，“设计一个梁”不算——抗震校核与报告也按用户请求执行）。修改任何配置档定义都必须更新版本号。

## 选择配置档

| 来源 | 方式 | 优先级 |
|---|---|---|
| 请求 | `/api/v1/chat/stream`、`/api/v1/agent/run` 或公共工具会话中的 `context.runPolicy.profile` | 最高 |
| 环境变量 | 后端进程（或直接导入 `backend/dist` 的进程）上的 `SCLAW_RUN_PROFILE=<id>` | |
| 设置 | `settings.json` → `agent.runPolicy.profile` | |
| 默认 | 无（完整系统） | 最低 |

完整优先级（由低到高）：默认 < 设置中的配置档 < 设置 `agent.runPolicy` 中的字段 < `SCLAW_RUN_PROFILE`
< 会话已保存的策略（之前的轮次）< 请求中的配置档 < 旧版请求字段（`context.skillIds`、`enabledToolIds`、
`disabledToolIds`）< 请求 `context.runPolicy` 中的字段。显式字段覆盖配置档字段，例如
`{ "profile": "no-clarification", "features": { "clarification": "enabled" } }` 会保留澄清功能。

每个配置档都完整指定机制字段（`knowledge`、`builder`、`routing`、`skillIds`、`repair.enabled`、
`features`），因此在会话中途切换配置档不会继承其他配置档的消融。会话在各轮之间沿用已保存的策略：
更换环境变量配置档时，请新建会话或在请求中显式指定配置档。

未知的配置档 ID 会立即以中英双语的 `UNKNOWN_RUN_PROFILE` 错误失败：请求校验阶段（在任何模型调用前拒绝请求）、
读取设置时，以及 `SCLAW_RUN_PROFILE` 在后端启动时。

`GET /api/v1/agent/run-profiles` 返回 `{ version, envProfile, profiles[] }`，每个配置档包含策略预设、
双语 `removes` 说明和针对的能力组。

### `SCLAW_RUN_PROFILE` 例外

运行配置通常只存放在 `settings.json` 中，环境变量仅用于基础设施（`SCLAW_DATA_DIR`、`NODE_ENV`）。
`SCLAW_RUN_PROFILE` 是唯一有意保留的例外，便于启动脚本让未修改的基准运行器切换到某个消融配置档。
它只能选择预先注册的配置档，不能表达任意策略。

## 配置档

能力组沿用 2026-10-12 基准评审：**A** 建模保真，**B** 结果解读，**C** 能力边界与缺失输入，
**D** 状态修订与版本，**E** 证据与报告溯源，**F** 约束下的候选方案选择。

| 配置档 | 策略 | 移除的机制 | 能力组 |
|---|---|---|---|
| `full` | 默认值 | 无（参照配置）；策略哈希与默认哈希一致 | — |
| `generic-only` | `skillIds` = 除 `generic` 以外的结构类型技能之外的全部技能（技能上限） | 专用结构技能；分析、校核、报告等其他领域保持不变 | A、B |
| `no-routing` | `routing: { mode: fixed, skillId: generic }` | 自动结构技能选择（不调用结构路由器） | A |
| `no-knowledge` | `knowledge: disabled` | 主代理、结构路由器和参数抽取提示词中的技能描述、触发词、阶段名称与阶段知识文本 | A、C |
| `no-template-builder` | `builder: llm` | 确定性模板建模器；`build_model` 改用大模型建模器 | A |
| `no-validation-gate` | `features.validation: disabled` | `validate_model` 工具及其工作流步骤；模型规范化与求解器检查保留 | A、C |
| `no-clarification` | `features.clarification: disabled` | `ask_user_clarification` 中断及相关提示；代理在最终回复中列出缺失输入 | C |
| `no-state-versioning` | `features.stateVersioning: off` | 模型、草稿、证据或设置修改后的过期结果失效；版本号、历史和哈希仍然记录 | D、F |
| `no-evidence-binding` | `features.evidenceBinding: off` | 报告与模型/运行/校核结果之间的溯源检查 | E、D |
| `no-repair` | `repair.enabled: false` | 自动规则回退与纠错重试，以及鼓励自动恢复的提示文本 | C、D |

### 各开关的运行时行为

- **generic-only**：作为技能上限生效，显式或旧版技能列表（例如基准的 `context.skillIds`）都与之取交集；
  被拒绝的 ID 记录在 `deniedSkillIds`。对结构技能而言等同于基准运行器自带的 `generic-only` 模式。
- **no-routing**：`detect_structure_type` / `extract_draft_params` 返回 `routingSource: policy-fixed`、
  `skillId: generic`。技能范围必须包含 `generic`，否则本轮以 `FIXED_SKILL_OUTSIDE_SCOPE` 失败。
- **no-knowledge**：技能名称、ID 和领域仍然可见；移除描述、触发词、阶段名称（主代理提示中的 `stages=`、参数抽取提示中的 `stages`）和阶段知识文本。
- **no-validation-gate** / **no-clarification**：工具从暴露列表中移除（工具结构不变，直接调用会被
  `TOOL_NOT_ALLOWED` 拒绝），系统提示词同步改写。工具因其他原因不可用（例如 `tools.disabledIds`）时，
  提示词同样保持一致。关闭澄清后，原本返回 `nextAction: "ask_user_clarification"` 的工具改为返回
  `nextAction: "report_missing_inputs"`。
- **no-state-versioning**：编辑照常提交新版本和历史记录，但已保存的分析、校核和报告结果仍视为当前结果；
  `currentAnalysisError` 忽略版本号/哈希不一致（未解决的输入证据仍会阻止）。
- **no-evidence-binding**：`generate_report` 将会话当前模型和校核结果与所选运行配对，不验证二者是否对应，
  跳过 `REPORT_MODEL_MISMATCH` 和 `REPORT_DESIGN_RUN_MISMATCH`，报告 JSON 带有 `meta.evidenceBinding: "off"`。
  代理运行之外的 HTTP `/api/v1/analysis` 报告接口保留原有检查。
- **no-repair**：本轮发生失败后，修改模型/设置及求解类工具会以 `RECOVERY_BUDGET_EXHAUSTED` 被拒绝；
  只读检查仍可用，代理如实报告错误。
  防护层仍然生效（见 agent-architecture_CN.md“防护层”）：最终回答完整性检查直接附注而不请求纠正，首次防护拒绝即结束本轮。

## 记录的字段

在已经记录运行策略的位置一并记录——运行记录台账（`<data>/run-records/<runId>.json`）、
`LangGraphRunResult.runPolicy` 和会话快照中的 `policy`；不新增流式事件字段：

- `profileId`——只要选择了配置档（包括 `full`）就会出现；
- `features`——仅当某项功能不是默认值时出现；
- `profileOverrides`——机制字段（`knowledge`、`builder`、`routing`、`repair.enabled`、`features.*`）的生效值
  与所选配置档预设不一致时，列出这些字段路径，例如第 1 轮 `{ "profile": "no-knowledge" }`、第 2 轮
  `{ "knowledge": "enabled" }` 得到 `profileOverrides: ["knowledge"]`。每轮重新计算；无偏离时省略。
  技能列表只会缩小范围（`generic-only` 作为上限强制执行），不计为偏离；
- `policyHash`——`profileId`（`full` 除外）、非默认的 `features` 和非空的 `profileOverrides` 计入哈希，因此默认配置与 `full` 的哈希与引入配置档前一致；
- `fieldSources`——每个字段的来源：`default`、`settings`、`env`、`session`、`legacy`、`request` 或
  `server-limit`；`fieldSources.profileId` 说明配置档的来源。

## 示例

```bash
SCLAW_RUN_PROFILE=no-clarification node tests/runner.mjs llm-benchmark --scenario <id>
```

```json
{ "message": "...", "context": { "locale": "zh", "runPolicy": { "profile": "no-knowledge" } } }
```
