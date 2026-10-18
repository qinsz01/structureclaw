# Analysis

- 默认分析类型可采用 `static`。/ Default analysis type: `static`.
- 默认流程：建模 → 分析，然后停止并总结结果，提示可继续按规范验算；用户要求报告或计算书时才生成报告。/ Default flow: model → analysis, then stop with a summary and offer a code check as a next step; a report is generated only when the user asks for a report or calculation book.
- 只求内力/反力时不需要材料截面（静定梁的内力与刚度无关）；之后求挠度或验算时再询问实际材料截面。/ Forces and reactions need no material or section (a determinate beam's forces do not depend on stiffness); ask for them when deflection or a check is requested later.
- 仅当用户明确要求规范验算（如“按 GB 50017 验算”）时再补 `designCode` 并执行校核；“设计一个梁”不触发校核。/ Run a code check with `designCode` only on an explicit request (e.g. "check against GB 50017"); "design a beam" does not trigger one.
- 梁荷载形式问题：点荷载或均布荷载
