# Engineering V2.2 preview / 工程内核 V2.2 预览

This is a bounded engineering-kernel preview, not acceptance of all 300 tasks or
all three engines. It extends the frozen V2.1 preview without moving paper tags,
replacing original answers, or running paid language-model experiments.

本轮已接通并验证的链路是：规范模型输入 → 同一工程服务 → 真实 OpenSees →
指定工况/物理位置查询 → 校核和报告。商业计算、识图端到端及逐题工程审定仍有未完成项。

## Implemented / 已实现

| Area / 模块 | Behavior / 行为 |
|---|---|
| Model fidelity / 模型保真 | V2.2 preserves explicit G, material design values and member design parameters; legacy extras migrate at the boundary. Conflicting geometry, section properties and catalog identities fail validation. / 显式刚度、设计参数保真，冲突不再静默取值。 |
| Run state / 运行状态 | Revision + model hash + settings hash + request sequence reserve each request. New requests invalidate current artifacts; late completion remains historical. Adapter provenance conflicts become failed archived results. / 旧请求不能冒充当前结果。 |
| Static mechanics / 静力 | The same principal section axes now govern 2D stiffness, local loads, end actions, member recovery and checks. Endpoint roundoff is admitted only at machine precision. / 二维截面转角贯通，斜杆端点查询消除浮点误判。 |
| Dynamics / 动力 | Modal, transient and seismic assembly share nodal/member/floor mass assembly and modal extraction; monitors and time indices are exposed. Zero directional mass fails; stepped/sloping floors require explicit nodal masses. / 质量不重复，缺激励方向质量不返回成功零响应。 |
| Checks / 校核 | Steel beam strength/shear/relative deflection, steel column axial/stability and supported RC beam checks consume actual run results. Pass, exceedance and missing-input cases use real solver runs. / 相对挠度扣除支座弦线位移，缺项不生成通过数值。 |
| Inputs / 输入 | Image/PDF recognition returns localized fields with file/page/region provenance. Focused crops retain original-page coordinates. Missing/ambiguous coverage remains unresolved; new required evidence invalidates prior results. Explicit reviews bind canonical fields and units to the model. / 新图、补图、图表冲突经同一证据链处理。 |
| Delivery / 交付 | Archived run lookup uses UUIDs and checks stored fingerprints. Exact queries record signed values, stations, sides, cases and units for the report table. / 图表数据与查询共用公共恢复，报告表格消费查询值。 |
| External tools / 外部入口 | OpenClaw consumes the application registry's JSON schemas and state reducers, including model edit/undo/query, multi-result analysis, paged PDF and input review. / 删除外部手写的平行参数定义。 |
| Evaluation / 评测 | 300-task mapping separates required/forbidden/output requirements. Eighteen candidate packs freeze inputs and independent references; new evaluation requires real execution evidence and checks station/side/unit/report errors. / 保留267/16/17引擎分配。 |

Details: [properties and checks](engineering-v2.2-properties-and-checks.md),
[commercial native evidence](commercial-native-acceptance.md),
[representative acceptance](../tests/llm-benchmark/acceptance/README.md).

## Evidence boundaries / 验收边界

- The deterministic representative harness feeds complete hidden physical models
  only to test the engineering tools. Twelve OpenSees cases cover nineteen model
  states, thirty-seven cases/combinations and 3240 requested quantities plus their
  visible report values. This does not measure language-model modeling accuracy or
  image recognition. / 工具链数值通过不能当作模型解题率或识图通过率。
- The independent NumPy reference does not import the production solver,
  converter or postprocessor. References and tolerances were frozen before the
  candidate runs. Sampled member extrema remain labeled as samples. / 不用生产恢复给自己证明正确。
- The six commercial candidates still need independently reviewed native models,
  signed full results and numerical calibration. Matrix values in those packs are
  diagnostic only. / 商业题不能替换成 OpenSees 即宣称通过。
- Image parsing contracts and missing/conflict/supplement workflows have
  deterministic tests. No paid vision call was run. Canonical object fields and
  reviewed `modelField` mappings are checked against actual model values;
  unbound semantic observations remain candidates, not certified interpretation.
  / 字段机制已接通，真实识图质量尚未验收。
- Frontend unit/integration tests cover rendering and state synchronization;
  these do not replace a blind review of every representative's final image and
  engineering explanation. / 18题题面盲审、最终图形及解释审阅仍需独立完成。

## Still required / 必须继续完成

1. Align the installed YJK version with its Python/.NET SDK; resolve PKPM's empty
   results/timeouts and calibrate axial deformation against the already frozen
   reference. / 先修复商业原生环境与最小数值闭环，不删除门禁。
2. Verify commercial E/G/nu/rho, effective self-weight/diaphragm/rigid-zone settings,
   load positions, full rotations/reactions/stations and inclined-member geometry.
   Only then connect production combinations, queries, plots and checks.
3. Independently review the eighteen input packs and native commercial references;
   run actual attachment-to-model workflows and inspect the final rendered outputs.
4. Register each remaining task's acceptance status separately. Do not extrapolate
   the eighteen candidates to the full 300-task suite.

本轮不增加完整墙壳、通用非线性或题目未要求的大型求解能力。没有把无法原生验证的能力
改名为“支持”。这些未完成项使本版本继续保留 **preview** 状态。

## Reproduction / 复现

Use the existing OpenSees Python runtime on PATH and set `SCLAW_DATA_DIR`. No model
provider key is needed for these checks. / 以下检查不需要模型 API 密钥。

```powershell
npm run build --prefix backend
npm test --prefix backend -- --runInBand
node tests/runner.mjs analysis-regression
node backend/tests/engineering-native-acceptance.mjs
node backend/tests/engineering-code-check-acceptance.mjs
node backend/tests/engineering-http-acceptance.mjs
npm run test:run --prefix frontend
npm run test:run:integration --prefix frontend
npm run type-check --prefix frontend
node tests/llm-benchmark/scripts/check-representative-pack.mjs --output=<new-output.json>
```

The dated `docs/archive/acceptance-records-2026-10/engineering-v2.2-preview-20261013.json` records
the verified commands, result counts, code/benchmark identities and remaining
capability blocks. Historical run artifacts stay in the configured runtime folder.
