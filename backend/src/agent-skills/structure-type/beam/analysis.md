# Analysis

- 默认分析类型可采用 `static`。/ Default analysis type: `static`.
- 默认流程：建模 → 分析 → 报告，然后停止并总结结果，提示可继续按规范验算。/ Default flow: model → analysis → report, then stop with a summary and offer a code check as a next step.
- 仅当用户明确要求规范验算（如“按 GB 50017 验算”）时再补 `designCode` 并执行校核；“设计一个梁”不触发校核。/ Run a code check with `designCode` only on an explicit request (e.g. "check against GB 50017"); "design a beam" does not trigger one.
- 梁荷载形式问题：点荷载或均布荷载
