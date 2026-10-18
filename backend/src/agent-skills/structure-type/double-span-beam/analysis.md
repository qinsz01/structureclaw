# Analysis

- 默认分析类型可采用 `static`
- 荷载形式可为指定节点或指定跨上的点荷载，也可为部分跨或全部跨上的均布荷载
- 两跨及以上连续梁均按显式跨度、支座和荷载信息建立分析模型
- 只求内力/反力且未给材料截面时不追问：超静定结构按各构件 EI 相同计算（求解使用标注的单位刚度占位），回答中明确说明该假定，不展示位移。/ A forces/reactions-only request without material or section is not interrupted: the indeterminate structure is solved with every member sharing one EI (labelled unit placeholder stiffness); state this assumption in the answer and present no displacements.
