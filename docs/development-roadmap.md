# StructureClaw 开发文档

最后更新：2026-03-09

## 1. 文档目标

本文件用于统一记录：

- 已实现功能（可运行能力）
- 后续开发阶段与优先级
- 每阶段的验收标准（Definition of Done）
- 风险与依赖

---

## 2. 当前已实现功能（As-Is）

### 2.1 工程与运行层

- 多服务骨架已可运行：`frontend` + `backend` + `core` + `docker-compose`
- 本地一键开发命令：`make doctor/start/status/stop/logs`
- Core 回归入口命令：`make core-regression`（契约 + 静力算例 + 数据模型样例）
- Backend 回归入口命令：`make backend-regression`（构建/lint/test + Agent/Chat 契约）
- CI 已接入 Core 回归工作流：`.github/workflows/core-regression.yml`
- CI 已接入 Backend 回归工作流：`.github/workflows/backend-regression.yml`
- 独立 CLI 已可用：`./sclaw ...`，并支持 npm 安装后直接 `sclaw ...`
- 基础启动检查已接入：后端/前端/core 的可运行性检查

### 2.2 Backend（Node.js/Fastify）

- API 基础前缀：`/api/v1`
- 模块路由已接入：
  - `users`
  - `chat`
  - `projects`
  - `skills`
  - `analysis`
  - `agent`
  - `community`
- 数据层基础能力：Prisma schema + migration + seed 已具备
- 缓存降级：支持 `REDIS_URL=disabled` 时回落内存缓存
- 已新增 Agent 编排入口：`POST /api/v1/agent/run`
  - 已新增工具协议查询：`GET /api/v1/agent/tools`
  - 支持自然语言请求 + 工具链执行轨迹返回
  - 当前工具链：`text-to-model-draft -> convert -> validate -> analyze -> code-check -> report`
  - 无模型输入时先执行文本草模；信息不足则返回结构化缺参提示
  - 报告支持落盘导出：`context.reportOutput=file`（输出到 `uploads/reports`）
- Chat 已复用 Agent 执行入口：`POST /api/v1/chat/execute`
- `POST /api/v1/chat/message` 新增 `mode` 开关：`chat/execute/auto`
- `POST /api/v1/chat/stream` 已支持 `mode`，可流式返回 Agent 执行事件
- Agent 可观测性增强：执行结果固定包含 `traceId/startedAt/completedAt/durationMs` 与工具耗时指标聚合（总耗时/均值/最大值/按工具汇总）
- 已新增 Agent 编排回归脚本：协议校验/缺参澄清/校验失败/成功编排/流式事件/文本草模 六类场景

### 2.3 Core（Python/FastAPI）

- 健康与服务接口：
  - `GET /`
  - `GET /health`
- 结构分析接口：
  - `POST /analyze`（`static/dynamic/seismic/nonlinear`）
  - 统一分析响应 envelope：`schema_version/analysis_type/success/error_code/data/meta`
- 规范与设计接口：
  - `POST /code-check`
  - `POST /design/beam`
  - `POST /design/column`
  - `POST /code-check` 已支持 traceability 上下文：分析摘要、条文、公式、输入参数与控制校核项
- 数据标准化接口：
  - `GET /schema/structure-model-v1`
  - `GET /schema/converters`（查询已支持转换格式）
  - `POST /validate`
  - `POST /convert`（支持 `structuremodel-v1`、`simple-1`、`compact-1` 的导入/导出，目标版本当前 `1.0.x`）
  - 已新增批量转换脚本与结构化报告：`scripts/convert-batch.py`
  - 已新增 `v1.x` 迁移骨架：支持 `target_schema_version=1.0.1` 并记录 `metadata.schema_migration`
- 现有数据模型雏形：`Node/Element/Material/Section/StructuralModel`

### 2.4 前端

- Next.js 前端骨架可运行
- 基础 UI 与页面结构已具备（当前以原型为主）

### 2.5 当前边界（需要明确）

- 目前仍是“可运行骨架 + 最小实现”，非完整工程计算平台
- 统一结构数据标准尚未正式固化（版本化/迁移机制待建）
- 分析/校核结果的工程级准确性、覆盖面、可追溯性仍需系统建设
- 样例回归已落地 20 个 `StructureModel v1` 基础样例，并接入本地校验脚本
- `POST /analyze` 已增加响应契约回归检查（固定字段与错误码）
- 已落地静力线弹性 `2D truss + 2D frame`（OpenSees 不可用时的内置求解路径），支持节点力/均布荷载/荷载组合/批量工况分析与黄金算例回归脚本（误差阈值可配置，当前 10 个算例）
- 已补充 `3D truss + 3D frame(最小子集)` 内置求解路径与黄金算例回归（当前 7 个算例，覆盖单工况/组合/批量包络）
- 静力结果已补充包络字段：位移/轴力/剪力/弯矩/支座反力最大绝对值，并输出按节点/单元/工况的控制值
- 已补充批量工况明细包络表：按节点位移、按单元内力、按节点反力的控制值与控制工况
- 已接入格式转换 round-trip 回归：`structuremodel-v1 -> simple-1 -> structuremodel-v1`
- 已接入 round-trip 通过率校验脚本：`scripts/validate-convert-passrate.sh`（阈值 95%）

---

## 3. 目标能力（To-Be）

最终建设以下五类核心能力：

1. Agent 编排与工具调用（OpenClaw 模式）
2. 结构计算分析
3. 结构格式统一转换
4. 文本到结构生成与计算
5. 结构规范校核与报告

---

## 4. 分阶段开发路线（建议）

## 阶段 0：Agent 编排层（最高优先级）

目标：建立“LLM 思考 + 工具调用”的统一执行入口，算法能力以 tools 方式被调用。

核心任务：

- 统一工具协议：`tool_name/input_schema/output_schema/error_code`
- 建立 Agent 入口：`/api/v1/agent/run`
- 打通最小工具链：`convert -> validate -> analyze`
- 建立缺参澄清机制（缺模型/缺荷载/缺边界条件）
- 加入工具调用轨迹与失败分类日志

验收标准：

- 同一自然语言请求可触发多步工具调用并返回轨迹
- 工具失败时返回结构化错误与下一步建议
- 无可用 LLM Key 时具备 rule-based 降级能力（`LLM_API_KEY/OPENAI_API_KEY/ZAI_API_KEY`）

## 阶段 A：统一结构数据底座（最高优先级）

目标：形成单一真源的 `StructureModel v1`，为后续分析/转换/AI/校核提供统一输入输出。

核心任务：

- 设计 `StructureModel v1`：节点、单元、材料、截面、边界、荷载、工况、组合
- 定义 JSON Schema + Pydantic 模型 + 版本字段（`schema_version`）
- 建立 `/validate` 与 `/convert` 基础接口（先做内部标准化）
- 建立模型迁移机制（v1.x 向前兼容）

验收标准：

- 能对输入结构模型做严格校验并返回明确错误定位
- 分析、转换、校核三类模块都以同一数据模型作为输入
- 至少 20 个标准样例通过模型校验


## 阶段 B：结构计算分析 MVP

目标：先打通“可用且可回归”的线弹性分析主链路。

核心任务：

- 优先实现静力线弹性分析（先 2D，再 3D）
- 支持基础荷载类型（节点力、均布荷载等）
- 输出标准结果对象（位移、内力、支座反力、包络）
- 构建回归算例库（黄金数据）

验收标准：

- 完整跑通“输入模型 -> 求解 -> 结果输出”
- 算例回归稳定（误差阈值可配置）
- `POST /analyze` 响应结构固定、可版本化


## 阶段 C：结构格式转换与互操作

目标：实现“多格式接入 -> 统一格式 -> 多格式导出”。

核心任务：

- 设计转换器插件接口（`import/export`）
- 首批优先支持 1-2 种高频工程格式
- 建立 round-trip 一致性测试
- 增加批处理转换命令与错误报告

验收标准：

- 至少 2 种外部格式可稳定导入/导出
- round-trip 样例通过率 >= 95%
- 转换失败有结构化错误信息（字段级）


## 阶段 D：文本生成、规范校核与自动报告（基于 Agent）

目标：形成“自然语言 -> Agent -> 结构模型 -> 计算 -> 校核 -> 报告”的闭环。

核心任务：

- 文本生成：`text -> StructureModel`（含约束与补全策略）
- 自动触发分析：生成后自动调用分析管线
- 规范校核：先做最小规则集（强度、变形、长细比等）
- 报告系统：输出可解释校核报告（条文来源、公式、控制工况）

验收标准：

- 文本输入可生成可计算模型（成功率可量化）
- 校核结果可追溯到规则与输入参数
- 可一键导出报告（JSON + 可读文档）

---

## 5. 全程并行建设（横向能力）

1. 测试体系：单元测试 + 集成测试 + 算例回归测试
2. 可观测性：任务日志、耗时指标、错误分类、链路追踪
3. 任务调度：异步队列、重试机制、大任务超时控制
4. 版本治理：模型版本、API 版本、规则版本联动管理
5. 工程质量：lint/type-check/CI/CD 与发布流程规范化

---

## 6. 建议优先级（执行顺序）

1. 阶段 0（Agent 编排层）
2. 阶段 A（统一数据底座）
3. 阶段 B（分析 MVP）
4. 阶段 C（格式转换）
5. 阶段 D（文本生成 + 规范校核 + 报告）

原因：

- Agent 是用户交互主入口，工具层应服务于 Agent 编排
- 不先统一模型，后续转换/AI/校核会反复返工
- 先拿到稳定分析主链路，其他高级能力才能建立在可验证结果之上

---

## 6.1 阶段完成度快照（2026-03-09）

- 阶段 0（Agent 编排层）：`已完成（MVP）`
  - 统一工具协议、Agent 入口、多步工具链、缺参澄清、调用轨迹与错误分类均已落地
- 阶段 A（统一数据底座）：`已完成（MVP）`
  - `StructureModel v1`、`/validate`、`/convert`、`v1.x` 迁移骨架与样例校验均已接入
- 阶段 B（分析 MVP）：`进行中（核心可用）`
  - 2D truss/frame + 静力回归与包络已完成；3D 与更高阶分析仍待补齐
- 阶段 C（格式转换）：`进行中（MVP）`
  - 已支持内部标准与简化格式 round-trip；外部工程格式接入待完成
- 阶段 D（文本生成+校核+报告）：`进行中（闭环可用）`
  - 自然语言到模型、分析、校核、报告闭环已通；报告模板化与能力深度仍待增强

---

## 7. 下一阶段执行规划（更新于 2026-03-09）

已完成基线（本轮不再重复投入）：

1. `text-to-model-draft` LLM+规则混合提取（可降级）
2. 会话级缺参澄清状态保持
3. 文本草模类型扩展（门式刚架/双跨梁/平面桁架）
4. Agent 执行链路可观测性（`traceId + timing metrics`）
5. Backend/Core 回归入口与 CI 基线

后续按 3 个迭代批次推进（建议每批次 3~5 天）：

### 迭代 P1：分析能力深化（阶段 B）

目标：

- 将“2D 可用”推进到“3D 起步可回归”，优先保证稳定可验收。

核心任务：

1. 增加 3D 静力线弹性最小求解路径（至少梁/杆单元基础场景）
2. 补 3D 黄金算例与误差阈值配置（新增回归脚本）
3. 对 `POST /analyze` 增加 3D 结果字段一致性检查

验收标准：

1. 新增 3D 回归算例 >= 6，`make core-regression` 全通过
2. 3D 场景输出位移/内力/反力基础字段完整
3. `POST /analyze` 在 2D/3D 下响应 envelope 一致

### 迭代 P2：格式转换扩展（阶段 C）

目标：

- 从“内部格式 round-trip”升级为“首个外部格式可用”。

核心任务：

1. 落地首个外部格式转换器（优先 `midas-text` 子集或 `ifc` 子集二选一）
2. 增加字段级错误定位（source line/field path）
3. 扩展 round-trip 与批处理报告（成功率与失败分布）

验收标准：

1. 至少 1 种外部格式可稳定 `import + export`
2. round-trip 总体通过率维持 >= 95%
3. 失败报告可定位到字段级错误（可机器消费）

### 迭代 P3：报告与交付体验增强（阶段 D + 前端）

目标：

- 提升“可读交付物”与“前端调试体验”，支撑外部演示和协作。

核心任务：

1. 报告模板化：增加章节目录、关键指标摘要、条文追溯块
2. 前端控制台补充报告预览与 artifact 快速定位
3. 增加一键导出（JSON + Markdown）验收脚本

验收标准：

1. 报告输出稳定包含摘要/条文/公式/控制工况
2. 前端 `/console` 可直接查看报告摘要和产物路径
3. `make backend-regression` 覆盖报告模板字段契约

## 8. 执行策略与风险控制（新增）

执行策略：

1. 先“核心能力可回归”，再“功能扩展”；所有新增能力必须带脚本回归
2. 每阶段完成后提交本地 commit（不 push），保持可回滚
3. 后端/核心/前端改动尽量解耦，避免跨层大改同时发生

主要风险：

1. OpenSees/依赖差异导致 3D 算例不稳定
2. 外部格式规范复杂度高，首版转换器边界不清
3. 报告模板过快复杂化影响回归稳定性

缓解手段：

1. 优先固定最小支持子集 + 明确不支持项
2. 用 golden case + 误差阈值保证演进可控
3. 新字段先进契约脚本，再进入默认输出
