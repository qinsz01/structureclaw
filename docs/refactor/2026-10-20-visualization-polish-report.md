# Visualization polish verification / 可视化细节修复验证

Date: 2026-10-20. Branch: `fix/visualization`. Starting commit: `ddb3e26`. Local commits only. / 日期：2026-10-20；原分支继续开发，仅本地提交。

The requested polish and all required checks passed. The complete default e2e run exited 0 after increasing the visualization audit allowance to accommodate the additional button-state checks. / 本轮细节修复及全部要求的检查通过；为新增按钮状态检查调整审计时限后，完整默认 e2e 运行退出码为 0。

The shared result formatter displays zero below `1e-9 × |peak|` for the same quantity, including diagram ends, legends, exports, native samples and side-panel values. Grouped force summaries also use the saved interior samples as their peak reference. Small but significant results retain scientific notation; saved solver values are unchanged. / 共用结果格式化器按同一物理量峰值的 `1e-9` 相对阈值归零，覆盖内力图端值、图例、导出、原生采样及侧栏；旧式内力汇总也使用已保存的跨内采样作为峰值参照。有效的小量保留科学记数法，不修改求解结果。

The main title uses an explicit structure name, description or type, otherwise “Analysis result / 分析结果”, followed by the case label. The run ID occupies a separate eight-character line, with its full value in a tooltip and copy action. Exported images retain the short run ID on a secondary line. Coordinate dimension alone is not treated as a structure type. / 主标题采用明确的名称、描述或结构类型及工况，无名称时使用“分析结果”；运行 ID 单独显示八位短码，tooltip 和复制操作保留完整值，导出图也有短码副标题。不会仅凭坐标维数推断结构类型。

Workspace-query values appear only in a matching view and, for diagrams, matching component. In-place object queries request the displayed quantity. Applicable toolbar buttons share token-based enabled, active, hover, focus and disabled styles. / 工作区查询值仅在视图及内力分量匹配时显示，就地查询请求当前视图对应的量；工具栏按钮共用基于设计令牌的各状态样式。

| Item / 项目 | Before / 修复前 | After / 修复后 |
|---|---|---|
| Diagram end values / 内力图端值 | Floating noise such as `1.332E-15 kN.m` / 浮点噪声 | `0 kN.m`; shared relative threshold, true diagram peak / 共用相对阈值，以真实峰值为参照 |
| Figure title / 图标题 | Full run UUID and raw case key / 完整 UUID 与原始工况键 | Human title and case; separate short ID with tooltip and copy / 人类可读标题及工况，短 ID 单独显示并可查看、复制完整值 |
| Query panel / 查询面板 | Displacement query remained in a moment view / 弯矩视图残留位移查询 | Hidden unless quantity and diagram component match / 仅在物理量及内力分量匹配时显示 |
| Fit and toolbar / 适配及工具栏 | Faint enabled/hover appearance in light theme / 浅色主题启用、悬停状态偏淡 | Token-based states; minimum measured text contrast `5.33:1` / 令牌化状态，实测最低文字对比度 `5.33:1` |

| Commit | Subject |
|---|---|
| `fabb66d` | fix(frontend): round viewer noise and match queried quantities |
| `470fa2b` | fix(frontend): clarify figure titles and viewer button states |
| `e3b68e6` | fix(frontend): refine result rounding and title fallbacks |
| `d17b75f` | fix(frontend): use true diagram peaks for numeric labels |
| `8ceb9be` | test(frontend): audit viewer polish and toolbar contrast |

The report is committed separately as `docs: record visualization polish verification`. The complete [commit list](G:/StructureClaw-All/verification/visualization-20261019/polish-20261020/commits.txt) includes its hash. Every commit uses the required Codex co-author footer; only explicit paths were staged. / 本报告单独提交，含报告自身散列的完整提交列表见链接；每条提交均含要求的共同作者尾注，仅暂存明确路径。

All commands below ran on the final production code. Logs are in `G:/StructureClaw-All/verification/visualization-20261019/polish-20261020/`. / 下列检查针对最终生产代码，日志保存在本轮验证目录。

| Check / 检查 | Summary / 摘要 |
|---|---|
| `npm run type-check --prefix frontend` | `tsc --noEmit` — exit 0 |
| `npm run lint --prefix frontend` | `eslint src/` — exit 0 |
| `npm run test:run --prefix frontend` | `46 passed \| 2 skipped (48)` files; `347 passed \| 6 todo (353)` tests; `134.75s` |
| `npm run test:run:integration --prefix frontend` | `12 passed (12)` files; `93 passed (93)` tests; `72.35s` |
| CLI `runFrontendBuild` | Compiled `6.1s`; TypeScript `14.1s`; `6/6` static pages in `792ms`; exit 0 |
| `npm run test:e2e --prefix frontend` | `49 passed (1.0h)`, `12 skipped`; exit 0; 46 default cases plus 3 model audits / 46 个默认用例及 3 个模型审计 |

The six TODOs and twelve opt-in live-provider cases are existing tests. Live-provider e2e was intentionally not run this round. No backend source or benchmark files changed. / 六个 TODO 和十二个需显式启用的真实模型用例均为已有测试；按要求本轮不运行真实模型 e2e，后端源码及 benchmark 文件未修改。

All **197** control checks are class **a**, with **0** class b/c checks and **0** browser errors. The audit requires actual canvas/content changes or a verified exported artifact; pressed styling alone does not count. / **197** 项控件检查全部为 **a** 类，b/c 类及浏览器错误均为 **0**；必须产生场景、内容变化或经验证的导出文件，仅按钮高亮不算通过。

| Model / 模型 | Class a | Matrix screenshots / 矩阵截图 | Opaque exports / 不透明导出 | Button-state contrast checks / 按钮状态对比度检查 | E2E duration / 耗时 |
|---|---:|---:|---:|---:|---|
| Beam / 梁 | 43 | 32 | 4 | 288 | `15.0m` |
| 2D frame / 二维框架 | 55 | 32 | 4 | 288 | `16.6m` |
| 3D frame / 三维框架 | 99 | 32 | 4 | 402 | `24.6m` |
| Total / 合计 | **197** | **96** | **12** | **978** | |

The matrix covers four views, light/dark, en/zh and 1440/768 viewports for every model. All 978 contrast measurements passed the `4.5:1` threshold; the minimum was `5.327371:1`. Enabled, actual hover and disabled styles were checked in every view and theme, including active controls. Disabled styles were measured using temporary offscreen clones. The four representative screenshots below were also inspected visually. / 每个模型覆盖四视图、明暗主题、中英文及 1440/768 视口；978 项对比度测量全部达到 `4.5:1`，最低 `5.327371:1`。逐视图、逐主题检查启用、实际悬停及禁用样式，包含激活控件；禁用样式使用临时屏外副本测量。下列四张代表截图另经人工视觉复核。

The [evidence summary](G:/StructureClaw-All/verification/visualization-20261019/polish-20261020/final-evidence-summary.json) verifies control classes, exports, all screenshot timestamps against the final server receipt, and complete contrast coverage. The [test summaries](G:/StructureClaw-All/verification/visualization-20261019/polish-20261020/frontend-check-summaries.txt), [control table](G:/StructureClaw-All/verification/visualization-20261019/controls.csv) and [full screenshot index](G:/StructureClaw-All/verification/visualization-20261019/screenshots.md) retain the detailed results. / 证据汇总校验控件分类、导出、全部截图的新鲜度及对比度覆盖，详细测试摘要、控件表和完整截图索引见链接。

The full matrix is regenerated in the same `beam/`, `frame2d/`, `frame3d/` directories under `G:/StructureClaw-All/verification/visualization-20261019/`. The previous matrix and control evidence are preserved under `polish-20261020/before/`; the original `G:/StructureClaw-All/viz-audit/` evidence is untouched. / 完整矩阵在原目录重新生成，上轮矩阵及控件证据已备份，原始审计目录保持不变。

Representative screenshots / 代表截图：

- [Beam diagram · dark · en · 1440](G:/StructureClaw-All/verification/visualization-20261019/beam/beam-diagram-dark-en-1440.png)
- [3D frame diagram · light · zh · 1440](G:/StructureClaw-All/verification/visualization-20261019/frame3d/frame3d-diagram-light-zh-1440.png)
- [Beam deformed · light · en · 1440](G:/StructureClaw-All/verification/visualization-20261019/beam/beam-deformed-light-en-1440.png)
- [2D frame reactions · dark · zh · 1440](G:/StructureClaw-All/verification/visualization-20261019/frame2d/frame2d-reactions-dark-zh-1440.png)

Earlier attempts are retained / 保留的早期运行：

- The first integration attempt had `1 failed, 92 passed` because the isolated database basename differed from the fixture's required `test-vitest-integration.db`. The launcher was corrected; the test was unchanged. See `integration-first.log`. / 首次集成测试的隔离数据库文件名不符合已有夹具要求，修正启动配置后重跑，测试断言未改动。
- The first browser attempt failed the former full-UUID-in-body assertion. Its error context also exposed a grouped moment summary that used end values as its peak. That implementation was corrected and regression coverage extended; the partial beam audit was stopped for a fresh build. See `before-grouped-peak-fix/`. / 首次浏览器运行遇到旧 UUID 正文断言，并发现旧式弯矩汇总峰值参照遗漏；修复实现及补充回归后中止不完整的梁审计，重新构建。
- An added title fixture initially declared 2D metadata on 3D geometry: `1 failed, 346 passed, 6 todo`. Correcting that fixture to match its geometry produced the final full unit pass. See `unit-before-fixture-correction.log`. / 新增标题测试曾使用与几何维数矛盾的元数据，修正夹具后全量单元测试通过。
- Another browser run was stopped during the beam audit after source review found that label rounding still referenced the drawing-scale floor for extremely small diagrams. Labels now use the true peak; all frontend checks and browser audits were restarted on a fresh build. See `before-raw-peak-fix/`. / 复核发现极小内力图的标注仍引用绘图缩放下限，故在梁审计期间中止另一轮浏览器运行，改用真实峰值后重新执行全部前端检查及浏览器审计。
- The first completed default run reported `48 passed, 12 skipped, 1 failed`: the 3D audit hit its previous 20-minute timeout after all 99 control checks had passed, while rendering the expanded matrix and checking button states. The audit allowance was increased to 30 minutes without removing assertions, and the complete default suite was restarted on a fresh isolated server. See `before-timeout-extension/`. / 首次完整默认运行的三维审计在 99 项控件检查全部通过后，生成扩展截图及检查按钮状态时达到原有 20 分钟上限；保留所有断言，将审计时限调整为 30 分钟，并在新隔离服务上重新执行完整默认套件。

All started test runners, browsers and isolated servers were stopped. At `2026-10-20 15:28:52 +08:00`, ports **31595**, **30999** and **3000** were free; the user's development listener on **31415** remained PID **24800**. No test process remained. See the [cleanup receipt](G:/StructureClaw-All/verification/visualization-20261019/polish-20261020/final-cleanup.json). No `./sclaw start`, push, backend source change or benchmark change occurred in this round. Original audit and frame-fixture SHA256 checks were unchanged, **5/5**. / 本轮启动的测试进程、浏览器及隔离服务均已停止；上述时刻三个端口均空闲，31415 的用户开发进程仍为原 PID 24800，无测试进程残留。本轮未执行 `./sclaw start`、推送、后端源码或 benchmark 修改，原始审计及框架夹具的五项散列均未变化。

No known issue remains in the requested polish scope. The six existing unit TODOs remain. The earlier live-provider failure recorded in the cleanup report was not reassessed because live-provider e2e was excluded from this round. / 本轮细节修复范围内没有已知未解决项；六项既有单元测试 TODO 保留，先前报告中的真实模型流程失败按本轮范围要求未重新评估。
