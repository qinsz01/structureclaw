# Design

- 该技能面向 GB50017 单规范校核，第一版按章节输出：第 7 章强度、第 8 章稳定、第 10 章正常使用极限状态。
- 仅在用户明确要求按 GB 50017 验算/校核时执行；普通设计或分析请求不触发。/ Runs only when the user explicitly requests a GB 50017 check; ordinary design or analysis requests do not trigger it.
- 当设计输入不足时，不追问、不使用默认值：交付已完成的校核，并列出未执行项及所缺输入，用户可在后续消息中补充。/ When design inputs are missing, do not ask or assume defaults: deliver the performed checks and list the checks not performed with their missing inputs; the user may supply them later.
- 后续扩展条文级实现时，保持 `summary`、`details`、`traceability` 输出结构稳定。
