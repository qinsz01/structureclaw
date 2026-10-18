# Analysis

- 默认分析类型可采用 `static`。/ Default analysis type: `static`.
- 默认流程：建模 → 分析 →（用户要求报告或完整设计/分析交付时）报告，然后停止并总结结果，提示可继续按规范验算。只求内力、反力、位移等具体结果时不生成报告。/ Default flow: model → analysis → report (only when the user asks for a report or a full design/analysis deliverable), then stop with a summary and offer a code check as a next step. Narrow requests for specific results (forces, reactions, displacement) get no report.
- 只求内力/反力时不询问材料截面：静定梁的内力与刚度无关，求解使用标注的单位刚度占位，不展示位移；之后求挠度或验算时再询问实际材料截面。/ Force-only requests never ask for material or section: forces of a determinate beam do not depend on stiffness, the solver uses labelled unit placeholder stiffness and displacements are not presented; ask for the real material and section when deflection or a check is requested later.
- 仅当用户明确要求规范验算（如“按 GB 50017 验算”）时再补 `designCode` 并执行校核；“设计一个梁”不触发校核。/ Run a code check with `designCode` only on an explicit request (e.g. "check against GB 50017"); "design a beam" does not trigger one.
- 梁荷载形式问题：点荷载或均布荷载
