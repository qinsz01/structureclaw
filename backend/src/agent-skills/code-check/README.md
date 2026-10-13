# Code-Check Skills

Purpose:
- Code-check input shaping
- One standard one skill routing
- Code-check result interpretation

Skill routing:
- `code-check-gb50010` folder -> GB50010
- `code-check-gb50011` folder -> GB50011
- `code-check-gb50017` folder -> GB50017
- `code-check-jgj3` folder -> JGJ3

## Result contract / 结果约定

`status: success` means execution completed, not code compliance. Read
`completionStatus` (`complete` / `incomplete`) and `complianceStatus`
(`pass` / `fail` / `incomplete` / `not_applicable`). These describe the requested,
implemented checks, not certification against every clause of a standard.

`status: success` 仅表示执行完成。是否完成校核、是否满足已执行项目分别由
`completionStatus` 和 `complianceStatus` 表示；不等于整本规范全部条文已认证。

Missing or invalid inputs produce `input_required`; unsupported capabilities
produce `unsupported`; measured violations produce `fail`. Production checking
derives utilization from the model and its selected analysis result; uploaded
utilization ratios cannot establish compliance. Explicit ratio overrides remain
only a low-level formula API/testing facility. A missing utilization is
`null`. `summary.inputRequired` and `summary.unsupported` count unresolved checks.

缺少有效资料、能力未实现与实际超限分别统计。缺失利用率为 `null`，不进入控制项，
不再按构件编号生成数值，也不默认补材料、配筋或使用阶段荷载。
正式校核从模型及所选分析结果推导利用率，上传的利用率不能作为通过依据；
显式比值覆盖仅保留于底层公式 API 和测试。

Concrete-frame templates do not generate reinforcement. Historical template
models with automatically inserted flat reinforcement fields require an explicit
`reinforcement: { confirmed: true, As, Asv, ... }` record (on an element, its
metadata, or its section) before those fields can be used. Areas are mm²;
diameters, spacing and cover are mm. Records marked `confirmed: false` or
`status: unconfirmed` are design suggestions, not existing reinforcement.

混凝土框架模板不自动生成配筋。历史模板中自动写入的扁平配筋字段不能直接用于验算；
须在构件、构件 metadata 或截面中显式提供上述已确认配筋记录。配筋面积单位为 mm²，
直径、间距、保护层为 mm；未确认记录仅为建议，不作为既有配筋。

`elementData.forceStates` preserves simultaneous signed station vectors. The
checker evaluates each station before selecting its controlling utilization.
`forceCoverage` distinguishes sampled recovered member responses from endpoints
only; neither claims an exact continuous extremum. Yield strength is never
substituted for steel design strength. V2 section-shape dimensions are mm,
section properties retain the schema's metre-based dimensions.

逐站点校核后再选控制值，不拼接不同截面的分量最大值。`forceCoverage` 明示采样恢复
或仅端点范围；均不冒充连续精确极值。钢材屈服强度不替代设计强度；截面几何严格按
V2 的毫米约定读取，截面属性按协议的米制量纲换算。

Existing uniaxial member formulas remain limited in scope. Biaxial bending and
torsion, unverified native commercial station conventions, and the simplified RC
eccentric-compression interaction are explicitly unresolved; the last may be
reported as a screening estimate but cannot establish compliance.

现有单轴构件公式保留其适用范围。双向弯曲与扭转、未验证的商业端力约定，以及
混凝土简化偏压交互不能据此宣称通过；简化偏压仅保留为筛查值。
