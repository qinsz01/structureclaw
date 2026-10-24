# Plotly 交互图表

本技能将结构分析结果以 Plotly 交互图表的形式呈现，支持以下图表类型：

| 图表类型 | 数据来源 | 说明 |
|----------|----------|------|
| 荷载-位移曲线 | `pushoverCurve` | Pushover 静力非线性分析结果 |
| 模态频率直方图 | `modalFrequencies` | 各阶模态频率与周期 |
| 内力包络折线图 | `forceEnvelope` | 各工况轴力/剪力/弯矩包络 |
| 反应谱曲线 | `responseSpectrum` | 设计谱与计算谱对比 |
| 滞回曲线 | `hysteresisCurve` | 非线性动力分析耗能曲线 |

图表数据由后端 `extractVisualizationHints()` 中的 `plotlyChartSpec` 字段提供，格式为标准 Plotly Figure JSON。

前端依赖：`react-plotly.js` / `plotly.js-dist-min`（按需懒加载）。
