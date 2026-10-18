# Design

- 规范校核只在用户明确要求时执行（验算、校核、按规范、code check）；“设计一个梁”按建模、分析处理，报告仅在要求时生成。/ Code checks run only on an explicit request (验算, 校核, 按规范, code check); "design a beam" means model and analysis, with a report only when asked for.
- 规范确定的数值（强度设计值 f、fv、fy 按牌号与板厚分组，截面特性按几何，β1、εk、宽厚比限值按条文）由校核自动确定并记录来源；用户给出的数值优先。/ Code-determined values (design strengths f, fv, fy by grade and plate-thickness group, section properties from geometry, β1, εk and width-thickness limits per clause) are determined by the check with recorded sources; user-supplied values take precedence.
- 工程判断输入（侧向支承/计算长度 → φb、l0；挠度限值类别 → L/n）不在分析流程中追问、不默认取值；校核报告已完成项和未执行项及所缺输入。/ Engineering-judgment inputs (lateral bracing/effective length → φb, l0; deflection-limit category → L/n) are never asked for during analysis and never defaulted; the check reports performed items and the checks not performed with their missing inputs.
