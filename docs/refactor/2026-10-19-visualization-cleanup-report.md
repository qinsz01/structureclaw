# Visualization cleanup acceptance report / 可视化清理验收报告

Date: 2026-10-20. Branch: `fix/visualization`, created from `work/research-next`. Local commits only; nothing pushed. / 日期：2026-10-20；分支由 `work/research-next` 创建，仅本地提交，未推送。

The later [visualization polish report](2026-10-20-visualization-polish-report.md) records the follow-up requested after screenshot review. This report's original artifact folders and indexes are archived at `G:/StructureClaw-All/verification/visualization-20261019/polish-20261020/before/`; the shared screenshot paths now contain the regenerated matrix. The historical results below remain unchanged. / 截图审阅后的细节修复见后续报告。本报告对应的原始证据目录及索引已备份，共用截图路径已重新生成；下文保留当时的验证结果。

**The visualization control audit passed, but overall acceptance is not met: one existing live-provider e2e workflow failed, and the first integration run disturbed the development watcher. This is not a claim that every requirement passed. / 可视化控件审计通过，但整体验收未满足：一个现有真实模型 e2e 流程失败，首次集成测试还触发了开发 watcher 重载，不能声称所有要求均已通过。**

## Delivered behavior / 已实现行为

The result workspace owns the saved run, case and queried object. The viewer keeps a read-only case and a link back, owns its view/component/display state, and runs object queries without closing. State resets for a different figure. Only applicable controls are shown. / 结果工作区持有运行、工况和查询对象；查看器只读显示工况并提供返回链接，持有视图、分量及显示状态，对象查询不再关闭查看器，切换图形时重置状态，仅显示适用控件。

Saved member samples now produce signed filled N/V/M diagrams with end/peak labels and adjustable ordinates. The change does not solve or fabricate structural results in the browser. Reaction arrows and moment arcs carry numbers; the reaction legend uses the actual maximum. Original geometry is a contrasting dashed line. Loads point toward their application points. Support classification excludes irrelevant 2D restraints. Camera presets move the camera in fixed global coordinates. / 直接用已保存的构件采样绘制带正负号填色、端值及峰值标注和比例调整的内力图，不在浏览器重新求解或补造结果。反力箭头及力矩圆弧带数值，图例使用实际最大值；原始形状采用对比虚线；荷载指向作用点；支座判断排除二维平面外约束；相机预设不再重映射坐标轴。

One export action produces an opaque 2× PNG with the figure title, units/legend, visible labels and a scale bar; deformation views also show their factor. Scene colors are centralized light/dark design tokens shared by WebGL, legends and export. New interface text uses the existing en/zh messages. Duplicate/dead extension APIs and repeated interaction colors were removed. / 单一导出操作生成不透明的 2 倍 PNG，包含标题、单位及图例、可见标注和比例尺，变形视图另有变形倍率。场景颜色集中为浅色/深色设计令牌，新界面文案使用现有中英文消息系统；删除重复及无用接口，合并交互颜色逻辑。

No backend production code, solver, skill prompt, dependency, freeze manifest or benchmark file was changed. The existing `memberResponses` payload supplied the required data. / 后端生产代码、求解器、技能提示、依赖、冻结清单和 benchmark 文件均未修改；现有 `memberResponses` 已提供所需数据。

In dense 3D diagrams, default numeric annotations identify governing members. Selecting a member shows that member's peak and ends; with no member selected, Element Labels reveals the complete annotations. This keeps the default plot readable while retaining access to every value. 2D annotations are unchanged. / 密集三维内力图默认突出控制构件；选中构件后显示其峰值与端值；未选中构件时可通过“单元标签”显示完整标注。二维标注不受这项调整影响。

## Commits / 提交

| Hash | Subject |
|---|---|
| `3912d0e` | fix(frontend): scope viewer controls and query objects in place |
| `4becb0a` | fix(frontend): draw signed diagrams and export annotated scenes |
| `a1d25b3` | test(frontend): cover viewer ownership and diagram geometry |
| `290e473` | fix(frontend): polish camera stability and figure annotations |
| `9501b20` | fix(frontend): keep diagram labels and reaction arrows readable |
| `4adbae6` | fix(frontend): focus numeric annotations in dense 3d diagrams |
| `6ae69d3` | test(frontend): align e2e assertions with current guard delivery |
| `750a4bd` | test(frontend): audit visualization controls and screenshot matrix |
| `67d6631` | fix(frontend): preserve scoped force-only result visualization |

Every commit ends with `Co-Authored-By: Codex <noreply@openai.com>`, separated from the subject/body by a blank line. Explicit paths were staged. / 每条提交均包含要求的共同作者尾注，仅暂存明确路径。

This report is committed separately as `docs: record visualization acceptance results and limitations`. The final [commit list](G:/StructureClaw-All/verification/visualization-20261019/commits.txt) includes its hash. / 本报告单独提交，含报告自身散列的最终列表见链接。

## Control audit before and after / 控件审计前后对比

The original evidence remains at `G:/StructureClaw-All/viz-audit/`. The adapted script is `frontend/tests/e2e/visualization-audit.mjs`, copied to the acceptance directory as `audit.mjs`. The exact historical frame inputs were recovered read-only from the old audit's saved model snapshots, without opening benchmark files; fixture provenance and hashes are in `frontend/tests/e2e/fixtures/visualization-models.md`. / 原始证据未覆盖；适配脚本已保存到前端 e2e 目录及验收目录。框架输入从旧审计已保存的模型快照只读恢复，来源和散列见夹具说明。

Classification: **a** = visible canvas/content effect, or a downloaded image that passes pixel checks; **b** = visible but incorrect behavior; **c** = no useful effect. Pressed-button styling alone does not pass. Canvas differences count pixels with any channel change greater than 20, with a threshold of 80 pixels; original-shape toggles must exceed 100. / 分类：a 为可见场景或内容变化，或通过像素检查的下载图片；b 为有变化但行为不正确；c 为没有有效变化。仅按钮高亮不算通过。像素差阈值为 80，原始形状开关为 100。

| Control / 控件 | Before / 之前 | After / 之后 |
|---|---|---|
| View / 视图 | Shared irrelevant toolbar state / 混用无关控件 | Scoped Model, Deformed, Diagram, Reactions / 按视图显示适用控件 |
| Original shape / 原始形状 | c: almost invisible on the grid / 与网格重叠难以辨认 | Contrasting dashed overlay above grid / 网格上方的对比虚线 |
| Deformation scale / 变形倍率 | b: refit on every tick; irrelevant views exposed it / 拖动重置相机、无关视图也显示 | Geometry changes with a stable camera / 只改变变形比例 |
| N/V/M and diagram scale / 内力分量与比例 | b/c: flat member tint; M2 locked / 构件单色、M2 锁定 | Signed sampled diagrams; all available components selectable / 采样内力图及可切换分量 |
| Node/member labels / 节点与单元标签 | a/b: labels could wrap vertically / 标签可能逐字换行 | No-wrap pills; end leaders separate joint annotations / 单行标签及端值引线 |
| Load markers and inspection / 荷载与检查 | b: point/nodal arrows reversed / 集中及节点荷载方向反了 | Arrow tips at application points; inspection updates / 箭头指向作用点并可检查 |
| Legend / 图例 | c in Model; b for reactions/buckling / 模型视图无效、部分图例错误 | Hidden in Model; true reaction range and matching buckling token / 仅适用视图显示并匹配实际数值或颜色 |
| Fit and double-click / 适配及双击 | b/c: double-click only cleared selection / 双击仅清除选择 | Both refit after zoom / 缩放后均重新适配 |
| 2D plane / 二维平面按钮 | c: no useful effect / 无有效作用 | Removed / 删除 |
| 3D camera / 三维相机 | b: remapped structural axes / 重映射结构坐标 | Front/Side/Top/Iso move the camera / 正视、侧视、俯视、等轴测移动相机 |
| Object chips and clear selection / 对象及清除选择 | a / 有作用 | Update focus/highlight/details; clear selection / 更新聚焦、高亮和详情并可清除 |
| Query object / 查询对象 | b: closed the viewer / 关闭查看器 | Actual query updates the side panel in place / 实际查询并在侧栏显示 |
| Case / 工况 | c: duplicate selector / 重复无效选择器 | Read-only with working workspace link / 只读工况及有效返回链接 |
| Export / 导出 | b: transparent, labels/legend absent / 透明且缺标注、图例 | Single opaque 2× annotated export / 单一不透明 2 倍带标注导出 |
| Close / 关闭 | a / 有作用 | Closes the viewer back to its owner / 返回所属工作区 |
| Force-only result availability / 纯受力结果可用性 | b: scoped recovered samples without displacement rejected the whole result / 无位移的已恢复采样使整个结果被拒绝 | Explicit unavailable scope preserves forces/reactions and suppresses deformation; contradictory displacement data is rejected / 明确不可用范围保留内力和反力，隐藏变形，并拒绝矛盾的位移数据 |

The old log contains 62 beam, 62 frame2d and 66 frame3d probes. Of these, 12/13/12 respectively had no canvas-hash or DOM change. Those old counts include download probes, so they are not directly comparable with the new validated-artifact criterion; the qualitative defects above come from the reviewed plan and original screenshots. / 旧日志记录 62、62、66 次操作，其中 12、13、12 次没有哈希或 DOM 变化；旧日志包含下载操作，不能直接与新版图片验证标准作数量比较。

| Model / 模型 | After: a | After: b | After: c | Original-shape changed pixels / 原始形状变化像素 | Opaque exports / 不透明导出 | Screenshots / 截图 | Browser errors / 浏览器错误 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Beam / 梁 | 40 | 0 | 0 | 1,482 | 4 | 32 | 0 |
| 2D frame / 二维框架 | 52 | 0 | 0 | 3,439 | 4 | 32 | 0 |
| 3D frame / 三维框架 | 96 | 0 | 0 | 5,739 | 4 | 32 | 0 |
| Total / 总计 | **188** | **0** | **0** | — | **12** | **96** | **0** |

Each retained control in the before/after table is class **a** after the change; the irrelevant 2D plane controls and duplicate case/metric selectors are removed. The detailed per-control pixel/DOM evidence is [controls.csv](G:/StructureClaw-All/verification/visualization-20261019/controls.csv); the machine-readable totals are [acceptance-summary.json](G:/StructureClaw-All/verification/visualization-20261019/acceptance-summary.json). / 保留的控件全部为 a 类，无关控件已移除；逐项像素、DOM 和导出证据见 CSV，汇总见 JSON。

## Screenshots and evidence / 截图与证据

Acceptance directory: `G:/StructureClaw-All/verification/visualization-20261019/`.

The complete [96-image screenshot index](G:/StructureClaw-All/verification/visualization-20261019/screenshots.md) links every Model, Deformed, Diagram and Reactions view for all three models, both themes, both locales and both widths. / [完整截图索引](G:/StructureClaw-All/verification/visualization-20261019/screenshots.md)覆盖三个模型的四种视图、深浅主题、中英文及两种宽度。

| Model / 模型 | Directory / 目录 | File pattern / 文件名模式 |
|---|---|---|
| Beam | `G:/StructureClaw-All/verification/visualization-20261019/beam/` | `beam-{model,deformed,diagram,reactions}-{light,dark}-{en,zh}-{1440,768}.png` |
| 2D frame | `G:/StructureClaw-All/verification/visualization-20261019/frame2d/` | `frame2d-{model,deformed,diagram,reactions}-{light,dark}-{en,zh}-{1440,768}.png` |
| 3D frame | `G:/StructureClaw-All/verification/visualization-20261019/frame3d/` | `frame3d-{model,deformed,diagram,reactions}-{light,dark}-{en,zh}-{1440,768}.png` |

Exports are `{scenario}-export-2x.png` for Diagram and `{scenario}-{model,deformed,reactions}-export-2x.png` for the other views, where `scenario` is `beam`, `frame2d` or `frame3d`. All twelve PNGs have zero nonopaque pixels; all nine result-view exports have a populated units/legend region. Every probe also retains its `*-before.png` and `*-after.png`. / 每个模型目录包含四张导出图和逐控件操作前后截图；12 张导出图均无透明像素，9 张结果图均包含单位及图例区域。

Manual inspection covered all four views for each model, the original-shape overlays, signed beam/frame diagrams, numeric reactions, camera presets, exported labels and light/dark en/zh responsive examples. The 3D default diagram shows the governing values without covering every joint; a selected member's ends and peak remain inspectable. / 已人工查看三个模型的四类视图、原始虚线、带符号内力图、数值反力、相机预设、导出标注以及深浅主题、中英文和窄屏样例；三维默认数值不再遮满节点，选中构件后仍可查看端值和峰值。

## Tests / 测试

All e2e and browser audits used `SCLAW_E2E_PORT=31595`, `SCLAW_E2E_PYTHON=G:/StructureClaw-All/sclaw_data/.venv/Scripts/python.exe`, and the isolated receipt-verified instance. / 所有 e2e 和浏览器审计均使用指定端口、Python 和通过身份验证的隔离实例。

| Command / 命令 | Final summary / 最终摘要 | Evidence / 日志 |
|---|---|---|
| `npm run type-check --prefix frontend` | `tsc --noEmit` — exit 0 | `type-check-complete-final.log` |
| `npm run lint --prefix frontend` | `eslint src/` — exit 0 | `lint-complete-final.log` |
| `npm run test:run --prefix frontend` | `Test Files 46 passed \| 2 skipped (48)`; `Tests 337 passed \| 6 todo (343)`; `Duration 142.31s` | `unit-complete-final.log` |
| `npm run test:run:integration --prefix frontend` | `Test Files 12 passed (12)`; `Tests 93 passed (93)`; `Duration 96.25s` | `integration-complete-final.log` |
| `scripts/cli/frontend-build.js` `runFrontendBuild` | `Compiled successfully in 7.6s`; `Finished TypeScript in 15.1s`; `Generating static pages ... (6/6) in 842ms` — exit 0 | `build-complete-final.log` |
| `npm run test:e2e --prefix frontend -- --grep-invert 'visualization controls'` | `12 skipped`; `46 passed (4.0m)`; the 12 live-provider cases are run separately below / 12 项真实模型测试另行运行 | `e2e-existing-complete-final.log`, `existing-complete-e2e/` |
| Beam audit / 梁审计 | `40 controls class a; 4 opaque exports; 32 screenshots; 0 browser errors`; Playwright passed in `9.2m` | `beam/beam-results.json`, `e2e-full-before-density.log` |
| 2D frame audit / 二维框架审计 | `52 controls class a; 4 opaque exports; 32 screenshots; 0 browser errors`; Playwright passed in `10.6m` | `frame2d/frame2d-results.json`, `e2e-full-before-density.log` |
| `npm run test:e2e --prefix frontend -- tests/e2e/specs/visualization.spec.ts --grep 'frame3d$'` | `96 controls class a; 4 opaque exports; 32 screenshots; 0 browser errors`; `1 passed (16.7m)` | `frame3d/frame3d-results.json`, `e2e-frame3d-final.log` |
| `validate-chat-stream-contract` with the existing backend build / 复用已构建后端 | `[ok] chat stream contract regression`; `PASS: validate-chat-stream-contract (existing build, no rebuild)` | `chat-stream-contract.log` |
| `SCLAW_E2E_LIVE=1 npm run test:e2e --prefix frontend` | `3 failed`; `9 passed (35.5m)` | `e2e-live.log`, `live-before-scope-fix/` |
| `SCLAW_E2E_LIVE=1 npm run test:e2e --prefix frontend -- --grep 'scoped force calculation'` after `67d6631` / 修复后 | `2 passed (4.6m)`; zh `2.7m`, en `1.8m` | `e2e-live-scope-final.log`, `live-scope-final/` |
| Actual failing force-only response replay / 实际失败的纯受力响应回放 | `162` samples retained; Model/Diagram/Reactions available, Deformed absent; input unchanged / 保留采样，视图范围正确，未修改输入 | `live-force-only-replay.json`, `verify-scoped-query.ts` |

The frontend build used the CLI module's exported `runFrontendBuild({ frontendDir: path.resolve('frontend') }, process.env)` through Node; the module has no standalone main. Chat-contract validation used `runBackendValidation` with `context.backendBuildReady=true` to avoid triggering the user's development watcher again. No full backend suite was required because no backend source changed. / 前端通过 Node 调用 CLI 构建模块的导出函数（该模块没有独立 main）；聊天契约验证复用已有后端构建，避免再次触发用户 watcher。后端源码未改动，因此未触发全量后端测试要求。

The two skipped unit files are the existing six TODO cases in `fonts.test.ts` and `theme-switch.test.tsx`; this change adds no skips. The new audit inherits the Playwright configured port and checks the saved server identity, while its standalone acceptance default remains 31595. / 单元测试的两个跳过文件为 `fonts.test.ts` 和 `theme-switch.test.tsx` 中已有的六个 TODO，本次未增加跳过项。新审计继承 Playwright 配置端口并核验实例身份，独立验收运行仍默认 31595。

Beam and frame2d completed their full audits before `4adbae6`; its only rendering change is guarded by `snapshot.dimension !== 2`, so their rendering path is unchanged. Frame3d was rerun on that build. The later `67d6631` changes only explicitly unavailable displacement scope; the three audited complete-stiffness models retain the same normalization and rendering behavior. Its force-only path is checked against the saved failing response, unit regressions and the two existing live browser cases. / 梁和二维框架完成全量审计后，`4adbae6` 仅改变三维数值标注，二维路径不变；三维已在该构建上重跑。后续 `67d6631` 仅处理明确声明位移不可用的范围，三个完整刚度审计模型的规范化和渲染行为保持不变；纯受力路径通过实际失败响应回放、单元回归及两个现有真实浏览器用例验证。

Using each live case's most recent result gives **11 passed, 1 failed across the full run and the two scoped reruns**. This is not a clean 12-case run. Both scoped reruns used the final immutable frontend build and retained the original numerical, query, scope and no-browser-error assertions. / 以每个真实模型用例的最近一次结果计，全量运行加两项定向复测为 **11 通过、1 失败**，不是一次 12 项全部通过的运行。两项复测使用最终不可变前端构建，保留原有数值、查询、范围和浏览器无错误断言。

The first full live run finished with `3 failed; 9 passed (35.5m)`. Two failures exposed the actual frontend rejection of scoped OpenSees samples: the backend explicitly omitted displacement, while the samples correctly retained `state: recovered`. Commit `67d6631` carries the explicit unavailable scope through validation and the case snapshot. An actual saved failing query was replayed unchanged: 162 member samples, Model/Diagram/Reactions available, Deformed absent. Regression tests also reject omitted displacements without explicit scope and reject displacement data that contradicts an unavailable declaration. / 首轮完整真实模型测试为 3 项失败、9 项通过（35.5 分钟）。其中两项暴露出前端拒绝纯受力采样的问题，已由 `67d6631` 修复。实际失败响应回放保留全部 162 个采样并恢复模型、内力图和反力视图，变形视图仍不提供；新增回归同时验证无明确声明的缺测及与不可用声明矛盾的位移数据会被拒绝。

Evidence: `e2e-live.log`, `live-before-scope-fix/`, `live-force-only-query.json`, `live-force-only-replay.json`, `verify-scoped-query.ts`.

Live provider: `open.bigmodel.cn`, `glm-5-turbo`, isolated port 31595, retries disabled. These are product e2e attempts, not benchmark scoring. / 真实模型：`open.bigmodel.cn`、`glm-5-turbo`，隔离端口 31595，禁用自动重试；属于产品 e2e，不是 benchmark 评分。

The first live attempt, generic beam building with guidance/repair disabled, failed in `5.2m`. `build_model` returned `LLM_MODEL_VALIDATION_FAILED` because `analysis_control.rigid_floor` was not a valid boolean. A later extraction was blocked by `RECOVERY_BUDGET_EXHAUSTED`, consistent with the selected no-repair policy. The session ended waiting for user input with no current analysis/report (`toolCalls=6`, `llmCalls=9`, `recoveries=0`). This is a failed agent workflow, not a completed analysis or a visualization pass. / 首项真实模型用例（关闭指导及自动修复的通用梁建模）在 5.2 分钟后失败：模型给出的 `analysis_control.rigid_floor` 不是合法布尔值，随后修改尝试被关闭修复的策略拒绝，最终等待用户输入，没有有效分析或报告。该次按真实失败记录。

Earlier run summaries are retained rather than replaced by successful reruns / 保留早期结果，不以重跑通过覆盖失败记录：

| Run / 运行 | Summary / 摘要 | Evidence / 证据 |
|---|---|---|
| Initial full unit | `46 passed \| 2 skipped (48)` files; `335 passed \| 6 todo (341)` tests; `181.19s` | `unit.log` |
| Initial full integration | `12 passed (12)` files; `93 passed (93)` tests; `160.75s` | `integration.log` |
| Focused visualization + result workspace | `12 passed (12)` files; `152 passed (152)` tests; `30.00s` | `targeted.log` |
| Annotation follow-up | `3 passed (3)` files; `21 passed (21)` tests; `11.58s` | `annotations-unit.log` |
| Initial full e2e attempt | `9 failed`; `12 skipped`; `40 passed (18.2m)` | `e2e-preliminary.log`, `preliminary-e2e/` |
| Full e2e before the final 3D annotation adjustment | `5 failed`; `12 skipped`; `44 passed (29.4m)` | `e2e-full-before-density.log`, `e2e-full-before-density/` |
| Pre-scope final unit/integration | Unit `46 passed \| 2 skipped (48)` files, `335 passed \| 6 todo (341)` tests, `138.58s`; integration `12 passed (12)` files, `93 passed (93)` tests, `92.20s` | `unit-final.log`, `integration-final.log` |
| Pre-scope default e2e | `12 skipped`; `46 passed (4.3m)` | `e2e-existing-final.log` |
| Scope regression before fix | `1 failed (1)` file; `1 failed \| 13 passed (14)` tests; `2.91s` | `force-scope-repro.log` |
| Scope regression after fix | `3 passed (3)` files; `53 passed (53)` tests; `6.46s`, then `6.25s` after the contradictory-input guard | `force-scope-unit.log`, `force-scope-unit-final.log` |
| Contradictory-input follow-up before the final guard | `1 failed \| 45 passed \| 2 skipped (48)` files; `1 failed \| 336 passed \| 6 todo (343)` tests; `134.47s` | `unit-scope-final.log` |
| Intermediate scoped integration | `12 passed (12)` files; `93 passed (93)` tests; `84.01s` | `integration-scope-final.log` |
| Default e2e rerun before the final guard's immutable build | `12 skipped`; `46 passed (4.2m)` | `e2e-existing-scope-final.log`, `existing-scope-e2e/` |

The initial six non-audit failures were obsolete delivery/tool-guard expectations. The beam/frame2d harness failures were the post-analysis Context entry. The later four non-audit failures were another persisted delivery-text assertion; all four bilingual code-check workflows now pass. Both interrupted 3D attempts are recorded as failures, not successes. / 初次六项非审计失败来自过时的交付及工具拒绝断言，梁和二维审计失败来自分析后的 Context 入口。第二次四项非审计失败是持久化交付文本的另一处旧断言；修正后四项中英文验算流程全部通过。两次中止的三维审计均记录为失败，未计作通过。

## Limitations and process accounting / 遗留事项及进程记录

The first full integration run used the repository's existing fixture, which executes `db:push` and backend `build`. This caused the user's `tsx` development watcher on 31415 to reload its child process (26568 → 24800 at 10:19:30). The watcher itself, PID 19084, was not stopped. This did disturb the development process and violated the requested isolation condition; it is not described as an undisturbed run. Subsequent integration checks reused a separately started, already built backend on 30999 and caused no further reload. / 首次集成测试的既有夹具执行 `db:push` 和后端构建，导致 31415 上 `tsx` watcher 的子进程在 10:19:30 自动重载（26568 → 24800）；watcher 19084 未停止。这确实影响了开发进程，违反了本次隔离要求，不能声称全程未干扰。后续集成检查复用 30999 上独立启动的已构建后端，没有再次触发重载。

The initial e2e attempt found obsolete expectations for noninteractive missing-input delivery and denied tools. These assertions were updated to the existing backend contracts; permission enforcement, truthful delivery, completion and failure checks remain. The audit also needed its post-analysis Context entry corrected. These initial failures are retained in `e2e-preliminary.log` and `preliminary-e2e/`; the old frame3d audit was intentionally stopped when annotation fixes required rebuilding. / 初次 e2e 发现缺项交付和工具拒绝码的旧断言，按现有后端契约更新，保留权限、真实交付、完成和失败断言。审计脚本修正了分析后的 Context 入口；初次失败记录保留，三维旧审计在标注修复需要重建后主动终止。

The remaining open item is the failed generic model-building live workflow in `live-run-settings.spec.ts:39`. Its malformed model and exhausted recovery budget happen before visualization. No required result field is missing, so changing backend validation, prompts or run policy to make this test pass would exceed the permitted backend exception. The failure evidence is retained in `live-before-scope-fix/test-results/live-run-settings-Live-pro-bbbca--and-generic-model-building-chromium/`. / 遗留项为 `live-run-settings.spec.ts:39` 的通用建模真实模型流程失败，发生在可视化之前；没有缺失的结果字段，因此修改后端校验、提示或运行策略来通过该用例超出本次允许的后端例外范围。原始失败证据已保留。

All started test commands and owned servers have ended. The last isolated server was PID 24972 (`playwright-38388fcc-3308-4d90-88d2-a48f488e1e13`); its live API key was cleared and verified empty before shutdown. The earlier live instance was also cleared before shutdown. Final port checks confirm **31595 and 30999 free**, **3000 free as at the start**, and the user's current **31415 listener still PID 24800**. See [ports-final.json](G:/StructureClaw-All/verification/visualization-20261019/ports-final.json). This cleanup does not undo or excuse the earlier reload. / 所有启动的测试命令和自有服务均已结束；最后一个隔离服务及之前的真实模型实例均在关闭前清除并验证凭据。最终确认 31595、30999 已释放，3000 与开始时一样空闲，用户 31415 当前仍为 PID 24800。清理并不能消除先前重载造成的隔离违规。

The original audit script, results and log still match the SHA-256 values captured before editing; both historical frame fixtures also match their provenance hashes. No `./sclaw start`, push or worktree removal was used. No backend or benchmark changes were made. The working branch contains the frontend implementation, its regression/audit coverage and this report. / 原始审计脚本、结果及日志与修改前保存的 SHA-256 一致，两份历史框架夹具也与来源散列一致。未执行 `./sclaw start`、推送或 worktree 删除；后端和 benchmark 无改动。当前分支包含前端实现、回归与审计覆盖及本报告。
