# Framework gaps, track B / 框架缺口 B 线

Branch: `fix/framework-gaps-B`. Implementation tested at `0b0da5b`.
No push, benchmark edits, ablation-version bump, or final freeze manifest.

分支：`fix/framework-gaps-B`，实现验证版本为 `0b0da5b`。未推送、未修改 Bench、未提升消融版本、未生成最终冻结清单。

## Changes and causes / 原因与修复

| Item | Cause and fix / 原因与修复 |
|---|---|
| R4 | Concrete-frame control records used `rigidFloor ?? true`. They now default to false. Template/runtime searches found no other enabled defaults for the five requested controls. PKPM and YJK projections explicitly disable omitted self-weight, rigid floors, rigid offsets, construction stages and P-delta; their native setting compilers also disable omissions. Explicit settings remain subject to capability checks. YJK rejects partially declared mixed story diaphragms. / 混凝土框架原来默认启用刚性楼板，现改为关闭。其余模板未发现这五类默认开启项；两种商业引擎的投影和原生参数编译均关闭省略项，保留显式设置和能力校验，并拒绝未完整声明的混合楼层约束。 |
| R5 | Missing controls left PKPM native defaults active, while complete-result adaptation required verified linear settings. Grade-only materials bypassed the explicit material/readback path. Grade defaults now enter before schema validation and native projection. C40/C30 use E=32500/30000 MPa, nu=0.2, rho=2500 kg/m³. Explicit values win; explicit null/invalid values still fail. Bilingual assumptions survive selected combinations. / 省略控制项与完整结果所需的线性设置校验冲突，只有牌号的材料又绕过显式材料核对。现于模型边界补齐牌号默认值，保留显式值及非法值拒绝，并将双语默认假设传递到组合结果。 |
| O4 | Canonical Z-up validation had no declared-source-frame boundary for V2 input. `source_frame` now accepts `y-up`, `z-up`, or a right-handed signed-axis map. Conversion covers node coordinates, six restraints, global forces/moments/distributed loads/imposed displacements, reference vectors and declared gravity/mass directions. The declaration is consumed once; metadata retains the mapping. `sourceFrameResults` restores nodal translations, rotations, forces and moments for selected and case/combination views. / V2 输入缺少源坐标系转换边界。新增 `source_frame`，统一变换节点、约束及全局向量，保留映射元数据，并输出源坐标系节点结果。 |
| P1 | There was a verifier but no reviewed generation workflow. The new script reuses its digest/binding/coverage helpers, requires a reviewed HEAD and clean runtime tree, verifies a temporary candidate with the unchanged verifier, and writes a dated output with exclusive-create semantics. / 原来只有校验器。新增生成器复用原有摘要和绑定校验，要求明确审阅的 HEAD 与干净运行代码树，先校验临时候选，再以禁止覆盖方式写入新日期清单。 |

Canonical models and canonical results remain Z-up. Member-local forces retain their local frame. Oblique or left-handed axes and source-frame openings are rejected; source-frame loads must use vector components. Story elevations require a positive source-up direction. These are declared framework limits, not scenario-specific exceptions.

规范模型与结果仍为 Z 向上，构件局部内力仍采用局部坐标。斜交轴、左手系、源坐标洞口和非向量荷载别名暂不支持；楼层标高要求源竖轴正向。这些是统一框架能力边界，不是针对特定题目的例外。

## Verification / 验证

Evidence directory: `G:/StructureClaw-All/verification/framework-gaps-20261021/B/`.

| Check / 检查 | Result / 结果 |
|---|---|
| Clean backend build, Prisma generation | Passed / 通过 |
| Backend lint / dependency boundaries | Passed; 288 modules, 798 dependencies / 通过 |
| Full Jest | Pending final summary / 等待最终汇总 |
| `npm run test:python --prefix backend` | 1,283 passed / 全部通过 |
| `node tests/runner.mjs analysis-regression` | Passed, including 63/63 converter round trips / 通过 |
| Agent orchestration, chat stream, analyze validators | All three passed / 三项全部通过 |
| Freeze verifier tests | 24 passed / 通过 |
| Generator tests with `SCLAW_FREEZE_REVIEW` | 2 passed, none skipped; two identical current-tree manifests and successful verify / 当前树生成两份一致清单并验证通过 |
| Frontend production build | Passed; artifacts needed by freeze verifier, no frontend source changes / 仅为冻结校验提供产物，未修改前端源代码 |

Backend dependencies were installed with `npm ci`; Prisma was generated before compilation. An ignored worktree-local `.venv` junction points to the supplied analysis Python because some tests intentionally replace their settings directory and otherwise select the Windows Python alias. Frontend dependencies were installed solely to produce the artifacts required by the unchanged freeze verifier.

已按要求安装后端依赖并在编译前生成 Prisma。部分测试会更换设置目录，故在本工作树建立被忽略的 `.venv` 目录联接，指向指定的分析 Python，避免使用 Windows Python 别名。前端安装仅用于生成原冻结校验器要求的构建产物。

Initial failures were retained in the evidence directory: obsolete PKPM mocks, prompt snapshots, Python interpreter selection, an optional historical evidence file missing from this checkout, and the live harness initially using skill IDs instead of engine IDs. None justified weakening the production verifier or changing frozen historical evidence.

初次失败日志保留：旧 PKPM mock、提示词快照、Python 解释器选择、当前检出不存在的可选历史证据文件，以及 live 脚本误将技能 ID 当作引擎 ID。均未通过放宽生产校验器或修改历史冻结记录处理。

## Live checks / 实机验证

These were HTTP API model/task runs through the isolated backend on port **31625**, using the specified data directory and actual solvers. They were not LLM answer-accuracy trials. Each scenario launched its solver once; the invalid engine-ID attempts stopped before solver execution.

以下为隔离后端 **31625** 上的 HTTP 模型/任务 API 与真实求解器验证，不是语言模型答题准确率实验。每场景仅实际求解一次；错误引擎 ID 的初次请求在求解前停止。

| Scenario / 场景 | Result / 结果 | Evidence / 证据 |
|---|---|---|
| Concrete-frame forces / 混凝土框架内力 | Passed, 3.687 s: 2 reaction nodes, 3 members; native execution metadata proves rigid floor off / 通过，执行元数据确认刚性楼板关闭 | `concrete-result.json`; run `40eac167-d95d-4750-86a6-cfcfb0a0619f` |
| PKPM two storeys, C40 below/C30 above, omitted controls / PKPM 两层、下 C40 上 C30、省略控制项 | Native solve passed, 46.782 s: 8 reaction nodes, 36 member station sets, combination U=1.2D. WMASS/GOUJIAN prove all five controls off; UserMaterial.SAT verifies both materials / 原生求解与回读通过 | `pkpm-result.json`; run `9b94359f-5df9-4fff-996a-858026e4ecc1` |
| Y-up cantilever / Y 向上悬臂梁 | Passed, 3.698 s: fy=-10 kN and mz=3 kN·m mapped to canonical fz=-10, my=-3. Source-frame support reaction fy≈10 kN, mz≈27 kN·m / 输入及反力回映通过 | `yup-result.json`; run `228f14e5-501a-48d0-9157-1094ea3def0b` |

The PKPM live assertion found that material assumptions were absent from the selected combination view. After fixing propagation, the same native result was reprojected without another solver call: all reactions, forces and local station quantities were unchanged, and the view contained ten recorded assumptions. The TypeScript-added global station annotation is outside that Python projection comparison. Evidence: `pkpm-reprojected-result.json`, `reproject-pkpm.py`, plus the regression test `test_boundary_grade_assumptions_survive_native_combination_selection`.

PKPM live 断言发现组合视图漏传材料假设。修复后对同一原生结果重新投影，未重算求解器；反力、内力及局部测站量保持一致，并包含十条假设。比较不包含 TypeScript 后处理添加的测站全局标记。相关文件与回归测试均已保留。

The owned 31625 server was stopped. No `sclaw start`, worktree removal, push, or operation on the user's 31415/3000 servers was performed.

已停止自建 31625 服务；未执行 `sclaw start`、移除工作树、推送或操作用户的 31415/3000 服务。

## Commits / 提交

- `33f1992` — disable implicit controls and resolve PKPM grade defaults.
- `3d28686` — declared source-axis mapping at the model boundary.
- `f2aaec9` — reviewed immutable freeze generator and integration test.
- `a0df9b4` — API boundary/default propagation and native setting completeness.
- `0b0da5b` — native defaults, capability-limit tests and prompt snapshots.

All commit messages include the requested Codex co-author trailer. / 所有提交均包含指定的共同作者尾注。

## Freeze operation and integration notes / 冻结与集成说明

After all tracks merge and the integrator reviews the baseline, supply a JSON review with `approved`, `reviewedBy`, ISO `date`, full `implementationCommit`, `dependencyTrees`, `nativeFiles`, optional `evidenceFiles`, and optional `workingDirectory`. Lists contain paths, not precomputed digests. Set `SCLAW_DATA_DIR` to the evaluated settings directory, then run:

各线合并并完成基线审阅后，提供含上述字段的审阅 JSON；文件清单填路径，摘要由生成器计算。设置被评估的配置目录后执行：

```text
node scripts/generate-scenario-freeze.mjs <review.json>
node scripts/verify-scenario-freeze.mjs docs/reproducibility/scenario-freeze-<YYYYMMDD>.json
```

The integration test used a temporary future-dated filename outside the repository, deleted it on completion, and did not establish a final accepted baseline. The historical default preflight still fails with `FROZEN_IMPLEMENTATION_CHANGED`, as expected. Its manifest and verifier were not edited.

集成测试仅在仓库外临时目录使用测试日期文件名，结束即删除，不构成最终基线冻结。历史默认预检仍按预期报 `FROZEN_IMPLEMENTATION_CHANGED`，其清单与校验器未改动。

Open integration items: generate the real freeze only after merging and review; let the integrator bump `ABLATION_PROFILES_VERSION` once; regenerate merged prompt snapshots if track A also changes the prompt. This track's `system-prompt.ts` edit is exactly one principle line. Unsupported implicit-slab floor pressures and uncalibrated H-column native axes now fail honestly rather than being masked by omissions.

待集成事项：合并审阅后才生成真实冻结；由集成人员统一提升消融版本；若 A 线也修改提示词，合并后重建快照。本线提示词仅新增一条原则。未校准的隐式楼板面荷载及 H 形柱原生轴映射会明确失败，不再由省略项掩盖。
