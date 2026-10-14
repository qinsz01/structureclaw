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

- `zh`: 通过系统公共工程服务执行三维梁柱模型的原生静力分析与显式请求的原生设计。每次原生作业保存源模型、投影、设置、日志和结果；同一次作业的工况集合供后续查询与报告复用。设计接入验收见 `docs/reproducibility/yjk-native-design-20261014.json`。
- `en`: Executes native 3-D frame analysis and explicitly requested native design through the shared engineering service. Each owned job retains the source model, solver projection, settings, logs and results. The same-job case set is reused for queries and reports; see `docs/reproducibility/yjk-native-design-20261014.json` for adapter acceptance.

- `zh`: 分析支持已映射的矩形、对称 H/I、等厚箱形和完整数值截面杆系；数值截面的参考载体仅用于弹性刚度装配。普通斜柱倾角须小于20°，底部为 Z=0。一阶杆系可选择自由楼层或全楼水平刚性楼板约束；后者经原生 MF 主从节点及楼层读回核对，仅约束平面内运动，不生成实体楼板、附加重量或面单元刚度。混合楼层约束和非水平刚性层尚未适配；刚域、P-Delta 与施工阶段仍须关闭。执行时核对实际几何、刚度、荷载与有效设置，不得更换构件角色、荷载或引擎规避缺项。
- `en`: Analysis supports mapped rectangular, symmetric I/H, equal-thickness box and complete numerical rod sections. Numerical-section carriers are elastic assembly details only. Ordinary inclined columns are below 20 degrees and bases are at Z=0. First-order rods support flexible floors or horizontal rigid diaphragms throughout the building. Native MF master/slave and floor readback verifies only in-plane constraints, without physical slabs, added weight or plate stiffness. Mixed floor constraints and non-horizontal rigid floors remain unmapped; rigid offsets, P-Delta and construction staging remain disabled. Actual geometry, rigidities, loads and settings are checked. Do not change member roles, loads or engines to hide missing capabilities.

- `zh`: 普通竖柱底部支持固定、铰支及全局方向约束，使用官方 SpNode 单点约束；每个源节点均与原生 FE 六自由度约束逐项核对。底部平移、转角和反力读取原生结果，未约束自由度不得补成零。梁端支持成对局部 ry/rz 释放并保留扭转；荷载分段只保留物理外端释放，内部连接连续。斜柱部分支座、高处对地支座、完全自由基底及弹簧尚需各自原生映射。
- `en`: Vertical-column bases support fixed, pinned and directional global restraints through official SpNode single-point constraints. Every source node is checked against all six executed FE restraint components. Base translations, rotations and reactions come from native results; free responses are never filled with zero. Beam ends support paired local ry/rz releases while retaining torsion. Load refinement releases only original physical ends and keeps internal joints continuous. Partial inclined-column supports, elevated ground supports, completely free bases and springs still need dedicated native mappings.

- `zh`: 普通竖柱和梁的自重按源密度、源面积及明确重力编译为原生全长竖向线载，包含坡梁的实际长度；只进入 `self_weight_case_id` 指定工况，省略时仅在恰好一个恒载工况时推定。默认重力为 9.80665 m/s²、全局 -Z；原生材料自动自重关闭以免双计。数值参考截面的载体尺寸不参与自重。分析与原生设计采用同份经过 FE 读回核对的荷载；普通斜柱自重和水平重力仍需专用原生通道，不能替换为节点合力。
- `en`: Weight of vertical columns and beams is compiled from authored density, area and resolved gravity into full-length native vertical line loads, including actual sloping-beam length. It enters only `self_weight_case_id`; omission is inferred only with one dead case. Defaults are 9.80665 m/s² in global -Z. Native automatic material weight remains disabled to prevent duplication, and numerical-section carrier dimensions never determine weight. Analysis and native design use the same FE-audited loads. Inclined-column weight and horizontal gravity still require dedicated native mappings; nodal resultants are not substitutes.

- `zh`: `caseResults` 与 `combinationResults` 保存源工况及经核对同刚度/设置的线性组合。`memberStations` 保存物理位置、侧别、有符号内力与来源。查询与报告使用公共结果服务，任何恢复值都须保留来源；未实现输出不填零，不用显示插值冒充计算。
- `en`: `caseResults` and `combinationResults` retain source cases and linear combinations under matching verified stiffness/settings. `memberStations` retains physical positions, sides, signed actions and provenance. Queries and reports use the shared result service; recovered values retain their origins. Missing outputs never become zero or display interpolation presented as calculation.

- `zh`: 原生设计必须显式传入 `design.requested=true`、实际规范和 `adoptedNativeDefaults=true`。混凝土矩形梁柱当前规范为 `GB/T50010-2010(2024)`，`required-reinforcement` 返回所需/计算配筋面积；这些面积不证明已配钢筋满足要求。钢 H/I 与箱形梁柱使用 `GB50017-2017`，官方应力与允许应力以 MPa 返回，保留有符号应力并以其绝对值计算利用率。原生未验算项、超限标志及缺失数据分别处理，不能把空数组推断为通过。
- `en`: Native design requires `design.requested=true`, the actual code and `adoptedNativeDefaults=true`. Concrete rectangular members use the current `GB/T50010-2010(2024)` profile; `required-reinforcement` returns required/calculated areas, not compliance of installed bars. Steel I/H and box members use `GB50017-2017`; official stresses and allowables are in MPa, with signed stress retained and utilization based on its magnitude. Native inactive checks, exceedance flags and missing data are distinct; empty arrays never imply a pass.

- `zh`: 设计参数包括 `beamCoverMm`、`columnCoverMm`、`beamStirrupSpacingMm`、`columnStirrupSpacingMm`，混凝土纵筋参数 `beamMainRebarGrade`、`columnMainRebarGrade`（HRB400/HRB500），以及钢柱计算长度方法 `steelColumnSwayX`、`steelColumnSwayY`（布尔值；不是指定计算长度）。C15 至 C80 的标准混凝土牌号已逐项原生读回。源构件 `rebar_grade` 为纵筋牌号，同层同类构件均明确且一致时按楼层映射；局部覆盖不能悄悄改变相邻构件。纵筋参数不改变箍筋牌号。
- `en`: Design parameters include `beamCoverMm`, `columnCoverMm`, `beamStirrupSpacingMm`, `columnStirrupSpacingMm`; concrete `beamMainRebarGrade`/`columnMainRebarGrade` (HRB400/HRB500); and steel `steelColumnSwayX`/`steelColumnSwayY` (boolean effective-length method switches, not specified lengths). Standard C15 through C80 concrete identities have each been read back natively. Source member `rebar_grade` denotes longitudinal bars and maps by floor only when every member of that role has an explicit consistent grade. A local override cannot silently change neighbouring members; main-bar settings do not change hoop grades.

- `zh`: 只有明确接受后才使用并读回其余原生默认条件；报告记录保护层、钢筋等级、计算长度、实际截面、材料牌号与设计组合系数。原生自动设计组合独立于用户静力组合，不能用当前分析工况替代控制设计组合。缺真实几何返回资料不足；尚未映射的源设计覆盖字段和分段构件设计明确返回不支持。
- `en`: Other native defaults are adopted only with explicit consent and read back. Reports retain covers, reinforcement grades, effective lengths, physical sections, material identities and design-combination coefficients. Native design combinations are separate from user analysis combinations; the selected analysis case cannot replace the governing design combination. Missing real geometry requires input; unmapped source design overrides and segmented-member design are reported explicitly.

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
