# 钢节点连接详图

本技能为 SkillHub 可拆卸技能（`skillhub.steel-connection-viz`），需从技能面板手动安装启用。

安装后，在三维结构场景中点击任意节点，将弹出该节点的连接详图面板，包含：
- 螺栓排布（行数 × 列数，间距，边距）
- 焊缝位置与类型（对接焊 / 角焊缝）
- 节点板几何（宽 × 高 × 厚）
- 连接力需求（Fx / Fy / Fz / Mx / My / Mz）

数据来源：`connectionForceMap`（来自 `extractVisualizationHints()`）与 `skillhub.steel-connection-check` 的验算结果。

> 依赖：需先安装 `skillhub.steel-connection-check`。
