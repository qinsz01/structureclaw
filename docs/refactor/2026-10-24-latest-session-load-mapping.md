# 最新会话荷载映射修复 / Latest-session load mapping

2026-10-24，跟进 [楼面荷载及会话边界检查](2026-10-24-floor-load-boundaries.md)。此前通过的用例不等于任意自然语言任务均能完成。本次保留原始失败，分别核对框架协议、模型输出和实际求解。

This follow-up separates framework defects, invalid LLM output and provider availability. No natural-language rule parser, template substitute, alternate model provider or substitute solver was added.

## 原会话 / Original conversation

15:40 创建的会话 `cmvm3a5ii0000mowm9697q8t2` 共 29 条消息，最后一次 trace 为 `94dd240d-137e-4e2e-bca3-9fe027cfbcff`。实际技能记录只有 `generic`。用户确认了三层空间框架方案，但校验收到草稿中不存在的荷载标识 `LD-BEAM-EDGE-DL-FLOOR-S1-E2`，在建模阶段停止；PKPM、校核、报告均未完成。失败候选的原始模型响应没有开启留存，不能声称已逐字恢复该候选。

The generic-only session stopped before solving. Its physics receipt identifies an invalid source-load mapping; it is not evidence of a completed PKPM run. Raw failed model responses were not retained in that session.

## 修复 / Corrections

- **源荷载标识。** 根据正式草稿生成允许的 `loadId` 枚举，并区分源荷载编号与生成的构件编号。多个目标通过选择器绑定；一次返回全部无效及重复标识、有效源标识清单。不得按名称、前缀或后缀猜测对应关系。
- **工况绑定。** `metadata.loadMappings[].caseId` 允许 LLM 将尚未指定工况的源荷载绑定到模型已有工况。已确认工况不能改名，重复或不存在的工况会拒绝。移除多工况时默认猜为 `LC1` 的行为；唯一工况可按结构化身份确定。
- **确认值与诊断。** 建模提示不再把 `skillState` 内部缓存与正式工程草稿一起声明为已确认参数。耗尽纠错后，中英文最终错误保留实际物理诊断及相关标识，不再只显示重复的 `MODEL_PHYSICS_INVALID`。失败仍停止依赖步骤并保留此前确认状态。
- **PKPM 楼层几何。** 真实三层框架复测发现原生层底 `8.100000381469727` 加层高后发生二次舍入，错误地不能绑定 MESH 中的顶标高 `11.699999809265137`。现在分别按原生 binary32 表示核对源层底与层高，再以核对过的源端点匹配实际网格。未扩大容差、就近匹配或改写几何；一位原生精度的真实层底/层高变化以及网格端点变化仍拒绝。
- **引擎能力声明。** PKPM、YJK 运行时只接受三维模型，原 Provider 元数据却沿用二维/三维默认值。已明确声明 `dimensions: [3D]`，向主模型提供目录中的维度、分析类型、结构族和能力说明，以及已有的优先/禁用状态。方案仍由 LLM 拟定；已确认的二维模型不能自动扩维或更换引擎。

Load identity and case binding are explicit contracts. Diagnostics survive terminal failure. Native floor verification compares declared components and actual mesh coordinates in the native representation without relaxing tolerances. Provider planning uses catalog capabilities rather than engine-name heuristics.

## 验证范围 / Verification scope

- 本地完整会话回归：24 个套件、130 项测试、57 个快照通过，无跳过。覆盖输入提取、建模、真实 OpenSees 求解、报告、修改失效、恢复及本次荷载标识/工况纠错。
- Python：1334 项及 30 个子测试通过。冻结求解样本和数值参考未改动。
- 真实 PKPM：三层、双向各三跨、64 节点、120 杆件，恒/活荷载工况分别独立核对 288/144 kN 支座反力，保存报告，确认引擎为 `builtin-pkpm` 且 `fallbackFrom=null`。
- 真实 GLM-5.3 建模器：同类已确认三维输入经一次候选纠错后通过几何、源标识、工况、荷载范围及总量核对；进一步接通真实 PKPM 和报告后仍为 288/144 kN。**外层工具调度和结构化参数提取使用固定测试脚本，只有建模候选来自真实 LLM；这不是完整自动拟方案任务通过。**
- 新能力文本涉及的 32 个提示词及指纹快照已更新并逐项比对。变化只限 Provider 说明、能力和拟方案约束；另外 12 个策略、工具及建模行为快照保持相同。冻结数值参考、公开工具参数 schema 和基准题库未改动。

The public API tests keep graph execution, validation, solvers, persistence and report generation real. Scripted LLM transport is labelled separately from the real model-builder calls; no refused case is counted as a successful solve.

The initially attempted duplicate-event optimization was withdrawn after event-order snapshots changed; it provided negligible reduction in this example. Full analysis embedded in report JSON accounts for most of the approximately 145 MB SSE transfer. This follow-up does not claim to have optimized that payload.

远端 Linux 检查还揭示旧任务生命周期测试假设 PID `1234` 不存在；该 PID 恰好在 CI 存活。测试现使用自建子进程，先检查活着的外部所有者不能取消，再退出该进程，检查未知结果状态和取消拒绝。没有修改产品任务所有权或放宽断言。

另一项真实求解查询测试把理论铰端弯矩直接断言为精确零；Linux 本次保存的是 `2.220446049250313e-16`。查询现在严格等于保存值经过正常 JSON 序列化后的数值，并核对显式/隐式字段查询及报告的同一数值记录。JSON 对负零的规范化不涉及非零值舍入。独立位移和反力参照及原有容差未改动；产品结果没有抹零。两处测试修复的完整 14 项本地复测通过。

## 未通过的真实任务 / Live-task limits

两次从原始开放设计请求开始的真实模型测试未计为通过：一次在共享纠错用尽后遗漏荷载绑定，另一次在生成过程中供应端超时。后一轮已按新能力说明提出三维方案，但没有完成模型、分析或报告。明确拒绝和超时都不等于工程任务成功。

原会话草稿还包含 `rho=2.55e-9`，与正式字段声明的 kg/m³ 及方案中的重度不一致。该值没有被按数量级猜测单位、替换为牌号默认值或写回历史数据。本次测试采用单独、明确给定的 SI 密度输入；不能据此宣称原草稿的密度已修正。

The original density extraction is not silently repaired. A new semantic extraction or an explicit corrected input is required before that historical draft can be treated as a correct self-weight model. These tests establish the covered contracts, not universal LLM reliability or arbitrary-engine compatibility.

## 最终收尾 / Final checks

31 个结构算例、8 个建模技能、3 个引擎共 93 个组合全部完成：43 个实际求解并保存报告（OpenSees 31、PKPM 5、YJK 7），50 个按能力边界明确拒绝，零非预期失败，零测试脚本错误。各工况总力、独立位移参照、保存结果查询、实际技能与所选引擎都有断言；这 50 次拒绝不计为求解通过。

At production source revision `a8502fc2`, [browser CI](https://github.com/qinsz01/structureclaw/actions/runs/40081853250) passes 61 tests in 22.4 minutes, with 12 optional live-provider tests skipped. Those skips are not counted as passes. Subsequent changes affect backend tests and this note only.

提交 `2617de15` 的 [后端完整回归](https://github.com/qinsz01/structureclaw/actions/runs/40084022266) 在 Windows、Linux 各自通过全部 249 个套件、3630 项测试、57 个快照，无测试跳过，两端均执行完整 21 项后端契约。独立 Python CI 为 1334 项及 30 个子测试通过；[分析回归](https://github.com/qinsz01/structureclaw/actions/runs/40084022268) 在两端也均通过。较早的事件顺序、提示词及两项跨平台测试失败保留在 CI 历史中，没有通过重跑掩盖。

The final backend run passes all 249 suites, 3,630 tests, 57 snapshots and all 21 contracts on each OS. Python passes 1,334 tests plus 30 subtests, and both analysis-regression platforms pass. The complete browser run uses the identical production source; later commits only repair backend tests and document evidence.

本地服务已重启并通过健康检查，原会话 29 条消息、完整输入审查、快照、策略、分析/报告状态及设置逐项比对保持相同，17 个前端资源均可读取。未自动重跑或覆盖原工程会话；旧错误记录仍保留。其他本地分支逐一比对未变，未合并 master，benchmark 指针仍为 `534e3f02b0593c16a035f32924dfbe7654ce68be`。

原始失败、复测、真实模型响应和最终验证清单保留在仓库外 `verification/latest-session-20261024`，不写入 benchmark。工程通过记录、能力拒绝、可选测试跳过及未完成的真实自动设计会话分别记录。
