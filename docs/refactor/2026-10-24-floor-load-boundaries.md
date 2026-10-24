# 楼面荷载、更新反馈与会话传输复查 / Floor-load and conversation follow-up

2026-10-24。继续检查 [跨引擎验收](2026-10-23-cross-engine-acceptance.md) 后，补充修复了以下缺陷。此前的通过记录只证明其已覆盖场景；本次发现说明不能将它等同于任意结构、任意输入均正确。

This follow-up covers confirmed floor-load compilation, partial updates, application diagnostics and idle chat transport. Natural-language interpretation still requires the configured LLM. No semantic parser, substitute provider or substitute solver was added.

## 修复内容 / Corrections

1. **受荷面积 / Loaded area.** 二维跨度不能平方得到楼面面积，也不能把一组无方向跨度复制到 3D 的 X/Y 两向。缺少面积时保留面荷载事实，通过 `frameFloorArea` 明确要求补参；即使另有可用节点荷载也不能跳过未解析的面荷载。
2. **工况类型 / Case classification.** OpenSees 只依据明确的恒载、活载类型绑定楼层分量，移除按工况 ID 前缀猜测类别的逻辑。空的风、地震、其他工况不会收到隐式重力荷载；明确选择工况后也不能回落为全楼荷载。
3. **工况归属 / Case ownership.** 多个隐式工况认领同一楼面分量时明确失败。派生节点记录缺少匹配的类型或楼层分量时明确失败，不能先丢弃记录再继续。
4. **小跨度总力 / Short-span force conservation.** 移除将小于 1 m 的跨度或面积钳制为 1 的换算。0.5 × 0.4 m 楼面上的 100 kN 总力原来可能只施加 20 kN；现在按实际面积保持 100 kN，并核对支座反力与轴向位移。
5. **显式拓扑 / Explicit topology.** 统一使用已投影的楼层范围和恒活载分量。屋面荷载不再扩展到所有楼层；ID 为 `L`、类型明确为 `dead` 的工况保持恒载。
6. **多轮更新 / Partial updates.** 合并完整几何及荷载后重算楼层总力。覆盖改荷载值、改跨度、移动楼层、恒活载切换和后续补齐 Y 向尺寸。仅修改 X 向尺寸不再丢失已确认的 3D 维度。
7. **未解决输入 / Unresolved input.** 新的面荷载缺少面积时保留此前确认的楼层总力，并阻止模型与分析发布。旧会话输入及冻结兼容样本保持原值。
8. **更新反馈 / Application feedback.** 提取补丁不再携带继承的楼层值；状态合并负责保留此前事实。应用审计区分明确声明的输入和生成的兼容视图；明确提供的楼层增量按楼层核对。被拒绝的数值、缺少楼层标识及无效数值仍报告 `NOT_RETAINED`，不能把失败改写成成功。
9. **SSE 保活 / Idle SSE.** 长时间等待模型时发送 SSE 注释保活；完成、失败时清理定时器，不向已关闭的连接发送保活。真实 HTTP 测试在 18 s 空闲超时条件下等待 31 s 后仍收到明确的 `LLM_TIMEOUT` 和结束标记。保活不产生工程进度或成功事件，也不放宽模型超时。

## 验证结果 / Verification

- 后端 246 个套件、3614 项唯一测试通过，无跳过或未解决失败。证据由完整运行及受影响套件的完整复测组成，不是一次全绿运行；原始失败记录保留。
- Python 1330 项及 30 个子测试通过；完整分析回归、63/63 转换往返、7 组路由/会话/分析契约、构建、lint 和依赖边界检查通过。
- 8 个结构技能、31 个结构算例 × 3 个引擎，共 93 个组合：**43 个实际求解并保存报告，50 个按能力边界明确拒绝**。拒绝不计作求解成功。58 组独立数值参考、各工况总力平衡、保存结果查询及实际使用技能均有断言。
- 25 个完整输入算例、29 轮模型编译逐一比较，确认保留旧值、补丁及传输修复没有改变这些有效输入的计算模型。
- 2 个真实 GLM-5.3 会话通过：显式屋面荷载及多轮混凝土框架修改。覆盖工况、总力、独立位移和保存报告；早期的测试脚本错误及供应端超时保留在证据中。

The matrix scripts only replace LLM transport with explicit structured extractions. Graph execution, skill handlers, validation, the requested installed solvers, saved runs, result queries and reports remain real. The separate live sessions use the configured real provider. Multiple HTTP turns assert `applied`, with no unretained input, before verifying the final numerical result.

The old `Backend Regression` workflow only ran automatically for master pushes. Dispatching it exposed missing Linux BLAS libraries, an incomplete Python dependency set and a Windows-only constant in a mocked process test. This follow-up adds work-branch triggering, installs the declared analysis runtime and its Linux libraries, verifies imports before testing, and supplies the Windows constant only inside the mocked test. No solver failures are skipped or replaced. Attachment tests use the common Python resolver, including `PYTHON_FOR_TEST`, instead of depending on personal settings; their complete suite also passes with an empty isolated data directory.

默认后端回归此前仅执行 21 项已登记契约中的 13 项，另外 8 项因未执行而保留了旧的技能注册断言。现在直接遍历契约注册表，全部纳入默认回归。契约检查准确区分 8 个结构技能与独立的执行 Provider；报告检查覆盖中英文已确认结果、单位、控制工况、失败状态及无 LLM 时的明确拒绝。形式校验保留显式截面数值和几何差异警告，同时拒绝非正面积及不合法的净截面模量。21 项契约已在隔离数据库完整通过。

The default backend runner now executes every registered contract rather than a separate 13-of-21 subset. Stale expectations for six modelling skills, execution providers as skills and successful natural-language work without an LLM were corrected against the current architecture. Explicit section properties remain authoritative with visible geometry diagnostics; invalid physical values still fail. The complete 21-contract local run passes without weakening numerical tolerances or adding production substitutes.

Windows CI 还暴露了 Python 选择不一致：依赖安装在指定解释器中，但工作进程经系统 `py` 启动了另一版本。CI 现在创建并使用 `backend/.venv`，依赖安装、工作进程与测试共用项目环境。修复仅涉及 CI，未增加产品配置回退。

Windows CI also exposed interpreter drift: dependencies were installed in the setup interpreter while workers discovered a different Python through `py`. The workflow now provisions `backend/.venv` and uses it for installation, workers and tests. Product configuration and solver selection are unchanged.

Linux 的完整运行进一步发现 5 份未注册可视化说明仍残留旧技能 YAML 头；原检查只识别 LF，因此 Windows CRLF 检出漏报。已移除旧头、保留正文，并同时检查两种换行。清理前后实际加载的 8 个结构技能完整内容逐字节相同。

The full Linux run additionally found five unregistered visualization notes with retired YAML skill headers. The LF-only guard had missed these on Windows. The headers were removed without changing the bodies, and the guard now covers LF and CRLF. Loaded modelling bundles were compared byte for byte and remain identical.

远端提交 `41850b1a` 的 [后端完整回归](https://github.com/qinsz01/structureclaw/actions/runs/40067567656) 已在 Windows 和 Linux 各自一次全绿：246 个套件、3614 项测试、57 个快照，无测试跳过；两端均执行全部 21 项契约。独立 Python 全套为 1330 项及 30 个子测试通过；[分析回归](https://github.com/qinsz01/structureclaw/actions/runs/40067567684) 也在两端通过。

At `41850b1a`, each Windows/Linux backend job passes all 246 suites, 3,614 tests and 57 snapshots in one complete run, with no skipped tests, followed by all 21 contracts. The Python job passes 1,330 tests and 30 subtests; both analysis-regression platforms also pass. Earlier failed CI runs remain part of the evidence.

同一提交的 [浏览器全套检查](https://github.com/qinsz01/structureclaw/actions/runs/40067567661) 为 61 项通过、12 项可选真实模型测试跳过，耗时 21.9 分钟，无失败、重试或不稳定通过。包括梁、空间框架和延迟尺寸通知下的居中及鼠标位置缩放，以及三类模型的可视化控制、PNG、语言和主题矩阵。部署复核确认原会话、草稿、模型、结果、待答问题、设置及 17 个前端资源均保持正确。

The same revision's browser suite passes 61 tests, with 12 optional live-provider tests skipped, in 21.9 minutes. There are no failures, retries or flaky passes. Camera centering/cursor zoom, held resize delivery and the visualization/export/locale/theme matrix pass. Post-restart checks preserve the original conversation, confirmed artifacts, pending question and settings, and verify all 17 served frontend assets.

Commercial engine boundaries remain explicit: unsupported model families, section/axis calibration, SDK grades and uncalibrated floor transfer are refused. Full-member nonlinear execution remains unavailable. This work does not add those solver capabilities or certify arbitrary prompts/models. The earlier optional live-browser skips and frontend TODOs are not counted as passes here.

## 复现 / Reproduction

```powershell
# Use an isolated settings/data directory with its analysis.pythonBin configured.
$env:PYTHON_FOR_TEST = '<analysis-runtime-python>'
$env:SCLAW_TEST_PYTHON = $env:PYTHON_FOR_TEST
npm run build --prefix backend
npm run test:python --prefix backend -- --tb=short -q
Push-Location backend
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand
Pop-Location
node backend/tests/structure-engine-acceptance.mjs --native-settings=<settings-path> --output=<isolated-evidence>
```

`--native-settings` copies allowlisted installation paths into test-owned work directories. A requested unavailable engine fails preflight. Neither this suite nor the live verification writes user conversations, user settings or the benchmark corpus. Local receipts, first failures, retakes and the verification manifest are retained under `verification/framework-matrix-20261023/floor-boundaries-20261024` outside the product repository.
