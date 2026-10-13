---
id: yjk-static
zhName: YJK 静力分析
enName: YJK Static Analysis
zhDescription: 保留 YJK 拓扑编译与授权、结果读取基础；材料牌号映射未原生验收，正式分析暂被能力门禁阻止。
enDescription: Retains YJK topology compilation, authorization and result-reader infrastructure; formal analysis is gated pending native material-grade acceptance.
software: yjk
analysisType: static
engineId: builtin-yjk
adapterKey: builtin-yjk
priority: 125
triggers: ["YJK 静力分析", "YJK 计算", "盈建科", "yjk static", "yjk analysis"]
stages: ["analysis"]
capabilities: ["analysis-policy", "analysis-execution"]
supportedModelFamilies: ["frame", "generic"]
runtimeRelativePath: runtime.py
---
# YJK Static Analysis

- `zh`: 当前正式运行在环境探测与创建工作目录之前保留兼容错误码 `YJK_NATIVE_MATERIAL_GRADE_UNVERIFIED`。混凝土逐构件牌号写入回读已修复；显式材料常数、有效设置与结果约定尚未全部完成物理校准。以下是已接通的原生执行基础，不代表任意正式 V2 计算已验收，也不得用环境探测通过绕过门禁。
- `en`: Formal runs retain the compatibility error code `YJK_NATIVE_MATERIAL_GRADE_UNVERIFIED` before environment resolution or work-directory creation. Per-member RC grade write/readback is repaired; explicit material constants, effective settings and result conventions still require full physical calibration. The native execution path does not certify arbitrary formal V2 inputs; environment availability cannot bypass the gate.

- `zh`: 当用户明确要求使用 YJK（盈建科）进行结构静力分析、商业引擎复核或与 PKPM/OpenSees 结果对比时使用。该 skill 需要本机安装 YJK 8.0，并配置 `YJKS_ROOT` 或 `YJK_PATH` 指向安装根目录。
- `en`: Use when the user explicitly asks for YJK-based structural static analysis, commercial-engine verification, or comparison against PKPM/OpenSees results. This skill requires a local YJK 8.0 installation and `YJKS_ROOT` or `YJK_PATH` pointing to the install root.
- `zh`: 执行链路为 V2/兼容模型归一化 → 生成 YDB → 通过 SDK `RunYJK(yjks.exe)` 启动 YJK → 建模修复、楼板/支座、前处理、整体计算 → 在 YJK 进程内加载 `extract_results.py` → 读取当前 run 的 `results.json` 并归一化为 StructureClaw 分析结果。
- `en`: The execution path is V2/compatible model normalization -> YDB generation -> YJK launch through SDK `RunYJK(yjks.exe)` -> model repair, slab/support setup, preprocessing, full calculation -> `extract_results.py` loaded inside the YJK process -> current-run `results.json` normalized into a StructureClaw analysis result.
- `zh`: 同步模式会返回 `displacements`、`reactions`、`forces`、`caseResults`、`envelope`、`envelopeTables`、`yjk_detailed.floor_stats` 和 `warnings`。每次运行的模型、日志、driver 输出和抽取结果写入 YJK 工作目录下的 `sc_<traceId>` 子目录；优先使用 `settings.json` / `YJK_WORK_DIR` 配置，Node 侧通常会从配置注入 `YJK_WORK_DIR`（默认 `<runtimeBaseDir>/analysis/yjk`），若仍未设置则 Python 运行时回退到 `~/.structureclaw/analysis/yjk`。
- `en`: Synchronous runs return `displacements`, `reactions`, `forces`, `caseResults`, `envelope`, `envelopeTables`, `yjk_detailed.floor_stats`, and `warnings`. Per-run models, logs, driver output, and extracted results are written under `sc_<traceId>` inside the YJK work directory; the runtime prefers `settings.json` / `YJK_WORK_DIR`, the Node runner normally injects `YJK_WORK_DIR` from config (default `<runtimeBaseDir>/analysis/yjk`), and if it is still unset the Python runtime falls back to `~/.structureclaw/analysis/yjk`.
- `zh`: 默认直接启动独立、隐藏的 SDK 宿主；显式绑定自己创建的 PID，并使用有时限的缓冲管道。安装互斥锁避免与 YJK Flow API 共用同一安装运行。需要授权预热时，可显式设置 `YJK_PREPARE_OWNED_LAUNCHER=1`，仅启动本次任务自己的隐藏启动器。
- `en`: The default starts an independent hidden SDK host, binds its owned PID and uses bounded buffered IPC. An installation lease prevents sharing an active YJK Flow API runtime. Explicit `YJK_PREPARE_OWNED_LAUNCHER=1` starts only this task's hidden launcher when authorization preparation is needed.
- `zh`: 驱动与子进程在启动前纳入 Windows Job；完成或超时均关闭本次进程树，保留原生文件。旧的附加用户窗口、键盘注入、全局进程差集清理及仅启动异步路径已删除。
- `en`: A Windows Job contains the driver before it launches vendor children. Completion and timeout close only that process tree and retain native artifacts. GUI attachment, keyboard injection, global PID-difference cleanup and start-only asynchronous execution have been removed.
- Runtime: `analysis/yjk-static/runtime.py`
