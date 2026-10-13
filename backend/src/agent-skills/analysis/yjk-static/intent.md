---
id: yjk-static
zhName: YJK 静力分析
enName: YJK Static Analysis
zhDescription: 执行经过原生校准的三维弹性杆系子集，逐次审计材料、几何、荷载、设置与有符号结果；未验证能力明确拒绝。
enDescription: Executes a natively calibrated 3-D elastic frame subset with per-run audits of materials, geometry, loads, settings and signed results; unverified capabilities are rejected explicitly.
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

- `zh`: 全面封禁已替换为输入约束与逐次原生证据门禁。2026-10-13 已验收 STD-088、INT-084 两个材料状态、MM-085 的物理模型，以及六方向荷载、局部均布与点力、反向构件端点、坡屋面修改和显式线性组合。这里只认证相应物理输入及数值，不等于这些题目的语言模型、多模态解释或全部300题已通过；完整记录见 `docs/commercial-native-chain-20261013.md`。
- `en`: A blanket execution ban is replaced by model contracts and per-run native evidence gates. Accepted physical models include STD-088, both INT-084 material states and MM-085, with additional six-direction, partial/point-load, reversed-endpoint, sloping-roof and explicit linear-combination calibration. This certifies the recorded physical inputs and numbers, not LLM/multimodal task success or all 300 cases; see `docs/commercial-native-chain-20261013.md`.

- `zh`: 当前范围为显式三维、底部 Z=0、已校准矩形截面的弹性梁柱模型；普通斜柱倾角须小于20°。每次核对实际 FE 的 EA、EI、GJ、剪切刚度、截面方向、连接、荷载和有效设置。当前审定分析设置关闭自重、刚性楼板、刚域、P-Delta 与施工阶段；不得把被拒输入改构件类型、改荷载、删输出或切换求解器来伪装支持。
- `en`: The present scope is explicit 3-D elastic beam/column models with base Z=0 and calibrated rectangular sections; ordinary inclined columns must be below 20°. Each run checks actual FE axial, bending, torsional and shear rigidities, section orientation, connections, loads and effective settings. Accepted settings disable self-weight, rigid floors/offsets, P-Delta and construction staging. Rejected inputs must not be disguised by changing member type, loads, outputs or solver.

- `zh`: `caseResults` 保留源工况，`combinationResults` 只对已核对同模型、同刚度、同设置的有符号向量线性组合。`memberStations` 提供明确物理位置、侧别、六内力分量与来源。公共后处理可按端力与明确荷载恢复截面内力，标记 `mechanics-recovery`；未校准跨内位移不填零、不用显示插值冒充。原生自动设计数组独立保留为 `nativeDesignResults`，其工况和数组解释未经审定，不产生利用率或规范通过结论。
- `en`: `caseResults` retains source cases; `combinationResults` superposes signed vectors only under matching verified model, stiffness and settings. `memberStations` records physical positions, cut sides, six force components and provenance. Public postprocessing may recover forces from end actions and explicit loads as `mechanics-recovery`; it never fabricates interior displacement. Automatic design arrays remain separate unverified `nativeDesignResults`, without inferred utilization or code-check conclusions.

- `zh`: 当用户明确要求使用 YJK（盈建科）进行结构静力分析、商业引擎复核或与 PKPM/OpenSees 结果对比时使用。该 skill 需要本机安装 YJK 8.0，并配置 `YJKS_ROOT` 或 `YJK_PATH` 指向安装根目录。
- `en`: Use when the user explicitly asks for YJK-based structural static analysis, commercial-engine verification, or comparison against PKPM/OpenSees results. This skill requires a local YJK 8.0 installation and `YJKS_ROOT` or `YJK_PATH` pointing to the install root.
- `zh`: 执行链路为 V2/兼容模型归一化与预检 → 确定性计算分段和 YDB → 独立 SDK 宿主 → 原生建模、前处理与整体计算 → `extract_results.py` 读回 → FE/材料/荷载/设置证据核验 → 物理对象与站点映射 → 源工况及组合结果。计算分段保留物理构件、位置及左右侧映射。
- `en`: The execution path is V2 migration and preflight -> deterministic solver segments and YDB -> owned SDK host -> native modeling/preprocessing/solution -> `extract_results.py` readback -> FE/material/load/settings audit -> physical objects and stations -> source cases and combinations. Segmentation retains physical members, positions and cut sides.
- `zh`: 同步模式会返回 `displacements`、`reactions`、`forces`、`caseResults`、`envelope`、`envelopeTables`、`yjk_detailed.floor_stats` 和 `warnings`。每次运行的模型、日志、driver 输出和抽取结果写入 YJK 工作目录下的 `sc_<traceId>` 子目录；优先使用 `settings.json` / `YJK_WORK_DIR` 配置，Node 侧通常会从配置注入 `YJK_WORK_DIR`（默认 `<runtimeBaseDir>/analysis/yjk`），若仍未设置则 Python 运行时回退到 `~/.structureclaw/analysis/yjk`。
- `en`: Synchronous runs return `displacements`, `reactions`, `forces`, `caseResults`, `envelope`, `envelopeTables`, `yjk_detailed.floor_stats`, and `warnings`. Per-run models, logs, driver output, and extracted results are written under `sc_<traceId>` inside the YJK work directory; the runtime prefers `settings.json` / `YJK_WORK_DIR`, the Node runner normally injects `YJK_WORK_DIR` from config (default `<runtimeBaseDir>/analysis/yjk`), and if it is still unset the Python runtime falls back to `~/.structureclaw/analysis/yjk`.
- `zh`: 默认直接启动独立、隐藏的 SDK 宿主；显式绑定自己创建的 PID，并使用有时限的缓冲管道。安装互斥锁避免与 YJK Flow API 共用同一安装运行。需要授权预热时，可显式设置 `YJK_PREPARE_OWNED_LAUNCHER=1`，仅启动本次任务自己的隐藏启动器。
- `en`: The default starts an independent hidden SDK host, binds its owned PID and uses bounded buffered IPC. An installation lease prevents sharing an active YJK Flow API runtime. Explicit `YJK_PREPARE_OWNED_LAUNCHER=1` starts only this task's hidden launcher when authorization preparation is needed.
- `zh`: 驱动与子进程在启动前纳入 Windows Job；完成或超时均关闭本次进程树，保留原生文件。旧的附加用户窗口、键盘注入、全局进程差集清理及仅启动异步路径已删除。
- `en`: A Windows Job contains the driver before it launches vendor children. Completion and timeout close only that process tree and retain native artifacts. GUI attachment, keyboard injection, global PID-difference cleanup and start-only asynchronous execution have been removed.
- Runtime: `analysis/yjk-static/runtime.py`
