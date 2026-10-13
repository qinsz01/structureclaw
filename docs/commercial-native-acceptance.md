# Native commercial adapters / 商业分析原生验收

The converters compile each natural floor independently. They preserve the input
plan nodes, member connectivity, per-member section selection and native IDs;
they do not fill a Cartesian grid or replicate a first-floor template.

转换器按自然层独立生成标准层，保留输入平面节点、构件连接、逐构件截面和原生编号；
不补齐矩形网格，也不把首层模板复制成全部楼层。

## Evidence levels / 证据分级

**Formal V2 commercial analysis is currently blocked.** PKPM only writes native
material grades; its accepted topology run did not read back or independently
calibrate E, nu, rho, G or section mechanical properties. Formal V2 materials
require E/nu/rho, so the preflight rejects these inputs with
`PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED` before native launch. A matching
nominal grade table is not proof of native numerical equivalence. YJK currently
writes material categories, without verified per-member grades; all formal runs
fail with `YJK_NATIVE_MATERIAL_GRADE_UNVERIFIED` before environment resolution or
work-directory creation. The launch, authorization, topology compilers and result
readers remain as implementation infrastructure, not a claim of formal readiness.

**当前正式 V2 商业分析暂不可用。** PKPM 只写入原生材料牌号，已通过的拓扑算例没有回读或独立
校准 E、nu、rho、G 和截面力学属性；正式 V2 材料必填 E/nu/rho，因此求解前明确拒绝，不能用名义
牌号表代替原生数值等价证据。YJK 目前只写材料类别，逐构件牌号未验收，正式运行一律在启动前
拒绝。启动、授权、编译和读取代码仍保留，但不表示正式求解已就绪。错误详情列出缺失能力和输入字段。

The low-level PKPM grade + geometry compiler rejects explicit material constants,
strength/reinforcement overrides, section A/I/J and other unmapped properties.
It accepts only supported shape fields in positive integer mm (no rounding), or
an unambiguous native standard-section name without geometry overrides. Legacy
V2.0 rectangular `properties.width/height` have an explicit metre convention;
new V2.1 models must use `shape` in mm. Mixed definitions, asymmetric/unknown
shape fields, fractional mm and conflicting top-level dimensions fail explicitly.
Native standard-section library property parity is still unverified; this path
supports compilation only. Existing original acceptance inputs contain explicit
E and now intentionally fail this stronger preflight; historical evidence is
retained without rerunning or rewriting it. The current topology-only acceptance
fixture explicitly requests a native grade, omits material constants and sets
`formalV2AnalysisAccepted: false`; it is not a formal V2 physics acceptance.

PKPM 底层牌号与几何编译同样拒绝显式材料常数、强度/钢筋覆盖及 A/I/J 等未映射属性；
尺寸采用明确正整数毫米，不四舍五入、不按大小猜单位。仅旧 V2.0 矩形 properties 尺寸按明确的
米约定兼容；新 V2.1 使用毫米 shape。重复定义、不对称或未知形状字段、非整数毫米及矛盾尺寸均拒绝。
原生标准截面库的力学属性等价性仍未验证，该路径仅保留编译能力。旧原生验收输入含 E，现会被更严格
门禁拒绝；历史证据保留，不改写历史输入。新的纯拓扑验收样例明确只要求原生牌号，并写入
`formalV2AnalysisAccepted: false`，不得当作正式 V2 物理验收。解锁需逐项完成原生写入回读及独立力学校核。

| Capability / 能力 | Evidence / 证据 |
|---|---|
| PKPM two-floor L-plan/setback, distinct beam sections / 两层 L 形退台、异梁截面 | Native JWS save/reopen preserved 6/4 nodes and 12/8 members; hidden SATWE execution returned 10 beams, 10 columns and signed station vectors / 原生回读及计算通过 |
| YJK individual joints, grids, beams, columns / 逐节点构件 | SDK declarations and converter contract test; native acceptance blocked by incomplete local installation / 声明与契约测试，原生环境未通过 |
| Signed native station vectors / 原始有符号截面力 | Retained separately from component envelopes; endpoint conventions remain unverified / 独立保存，端部符号约定待验收 |
| Node loads, full-span vertical beam UDL, custom load cases / 节点荷载、全跨竖向均布与自定义工况 | PKPM candidate SDK writer and native save/readback exist; sign/case solver calibration pending, production remains closed / 候选写入与回读已有，求解校准未通过，不放行 |
| Requested linear combinations / 指定线性组合 | Shared signed-vector combiner enforces identical verified model/stiffness/settings/station coordinates; adapters reject until evidence is available / 公共组合器已实现，原生证据未通过时适配器拒绝 |
| Sloping members, releases, offsets, springs, settlement / 斜构件、释放、偏心、弹簧、沉降 | Not yet enabled in these floor compilers / 尚未放行 |
| Explicit self-weight/diaphragm/rigid-zone/construction/P-delta controls / 显式自重楼板刚域施工与二阶设置 | Reject until native setting write/readback is accepted; unspecified legacy defaults are not proof of OFF / 写入回读未验收前拒绝，未声明不等于关闭 |
| PKPM reactions / 支座反力 | No direct reader in the installed ResultData interface; derived equilibrium requires signed endpoint vectors and verified axes/signs/offsets / 尚无直接读取，平衡恢复尚待端力约定验收 |
| PKPM rotations / 转角 | Installed NodeDisp exposes translations only; no zero-filled rotation components / 本机节点接口仅有平移，未补零冒充转角 |

Duplicated story-derived nodal loads are checked against each story's canonical
`load_area_m2`, not a global bounding rectangle. Missing area, conflicting floor
load aliases, wrong floor elevation, wrong gravity direction and mismatched
resultants fail. This checks load bookkeeping, not native floor-to-member load
transmission. Material G and other explicit physical constants remain subject to
the native material gate; a successful grade readback does not preserve them.

楼面荷载的等效节点副本按每层 `load_area_m2` 分别核对，不再使用全楼包围矩形。
缺面积、来源冲突、楼层错误、重力方向错误与合力不一致均失败。这只校核荷载账目，
尚不能证明原生楼面传荷正确。显式 G 等材料常数仍受原生材料门禁约束，牌号回读不能代替它们。

PKPM execution status and output completeness are separate. Successful native
execution may return `capabilityStatus: partial` with missing rotations,
reactions, physical station coordinates and axis/endpoint conventions. Raw
signed native stations remain available; they must not be interpreted as
verified physical-member endpoint vectors or used to recover support reactions.

PKPM 执行成功与输出完整性分别记录。执行成功仍可为 `capabilityStatus: partial`，
明确缺少转角、反力、物理站点位置及局部轴/端点约定。原始有符号站点数据继续保留，
但不能冒充已校准的物理构件端力或据此恢复支座反力。

Each request selects at most one input case. Verified dead/live cases are mapped
to native labels; a missing/ambiguous mapping fails instead of returning DL.
Requested combinations currently fail explicitly. Native design envelopes are
not represented as the requested case's simultaneous endpoint vectors.

每次请求至多选择一个输入工况。恒活载按原生标签匹配；缺失或歧义会失败，不默认返回恒载。
请求指定组合目前会明确失败。原生设计包络不能用作某工况的同一端截面力向量。

## Reproduce / 复现

Use `backend/tests/analysis-commercial-native-acceptance.py` with a new work root.
It always creates a unique directory, retains the input and `acceptance.json`,
and never attaches to an existing YJK GUI. `--run` requires an explicit PKPM
JWSCYCLE path. The launcher hides the new process and restores DirectorySet.conf.
Do not run it concurrently with another PKPM batch process: the vendor directory
configuration is shared across processes.

```powershell
& '<engineering-python>' backend/tests/analysis-commercial-native-acceptance.py pkpm --work-root '<acceptance-root>' --run --cycle '<PKPM>/PkpmCycle/JWSCYCLE.exe' --timeout 90
& '<YJK-bundled-python>' backend/tests/analysis-commercial-native-acceptance.py yjk --work-root '<acceptance-root>' --yjk-sdk '<YJK-sdk-site-packages>'
& '<engineering-python>' backend/tests/analysis-pkpm-native-calibration.py --work-root '<acceptance-root>' --build-only
& '<engineering-python>' backend/tests/analysis-pkpm-native-calibration.py --work-root '<acceptance-root>' --cycle '<PKPM>/PkpmCycle/JWSCYCLE.exe' --timeout 120
```

2026-10-13 evidence: PKPM `acceptance-commercial-pkpm-20261013-115755-ea18fbcc`
passed topology readback and solver result coverage in `sclaw_data/work`.
YJK attempts `acceptance-commercial-yjk-20261013-115925-fae10d8d` and
`acceptance-commercial-yjk-20261013-120011-f131697d` failed at SDK import
(`_cffi_backend` ABI/dependency and `ClrYJKAPI.dll` dependency respectively).
The configured full YJK installation path did not exist. No existing YJK project
was opened, attached, closed or modified.

Additional evidence from 2026-10-13, stored in `sclaw_data/work`:

| Run / 运行 | Observed evidence / 实际证据 | Limit / 边界 |
|---|---|---|
| `acceptance-commercial-pkpm-20261013-145245-9f25ef94` | Native save/reopen verified two natural floor elevations/heights, all 20 beam/column endpoints, per-member C30 grades and distinct rectangular B/H dimensions / 两层标高层高、20根构件双端、逐构件牌号与截面尺寸回读通过 | Build/readback only; no new physics claim / 仅建模回读 |
| `pkpm-axial-20261013-143900-5cc10e96` | Four-column axial reference frozen before candidate assembly; native readback succeeded, solver produced no usable LL displacements / 先冻结四柱轴压解析参考，回读成功但无可用活载位移 | Numerical acceptance failed / 数值验收失败 |
| `pkpm-axial-20261013-144223-37236370` | Native launch timed out at 120 s after assembly/force-processing logs / 120 秒超时 | Numerical acceptance failed / 数值验收失败 |
| `pkpm-axial-20261013-144622-8b3fb009` | Repeat timed out at 360 s with the same foundation-interface phase / 360 秒仍停在基础接口阶段 | Repeated external runtime obstruction; do not relax tolerance / 重复原生运行障碍，不放宽容差 |
| `pkpm-axial-20261013-151349-1a58c117` | Candidate SDK writer asserted all four live node-load IDs/vectors, explicit project settings, column grades and floor height on save/reopen / 候选接口的四节点活载编号与六分量、显式设置、柱牌号和层高保存回读断言通过 | `--build-only`, explicitly partial; not solver validation / 明确仅回读、非求解验证 |
| `pkpm-load-schema-1d961885` | Custom case name/type/kind survived native save/reopen / 自定义工况名称、类型与性质保存回读 | Custom case/result label semantics remain uncalibrated / 工况传入求解及读回对应关系待验收 |

The axial script freezes `P = 1 kN`, `L = 3 m`, `A = 0.36 m²`,
`E = 30000 MPa`, and `uz = -PL/(EA) = -2.777777777777778e-7 m` before native
creation. Its fixed relative/absolute tolerances are `1e-5` / `1e-11 m`.
The script records reference hashes, requested settings, native readback and
observed solver outputs separately. This reference covers axial stiffness under
the live case only; even a pass would not establish G, density, general frame
bending, load-axis signs or the remaining material combinations.

轴压脚本在创建原生模型前冻结上述解析值与容差，分别保留参考哈希、请求设置、原生回读和求解输出。
即使轴压通过，也只证明该活载轴向刚度，不证明 G、密度、一般框架弯曲及所有荷载方向或材料组合。

The local YJK installation discovered during the audit is `E:/YJKS/YJKS_6_0`,
with Python 3.8. The cached API is the 8.0/Python 3.10 SDK. No matching full 8.0
installation was found at the configured path. SDK import failures and this
version mismatch are recorded as environment limitations; the existing YJK GUI
was not attached to, restarted or changed. Mixing vendor DLL versions is not an
accepted repair. YJK 8.0 SDK declarations expose `Load_Def`, `load_arrange`,
`GKLoad_Def`, joint height differences and beam end elevations, but their wire
semantics/native effects have not been calibrated. Ordinary slanted columns
still need an actual two-end geometry mapping; replacing them with braces is
not permitted.

本机找到的是 YJK 6.0/Python 3.8，缓存却是 8.0/Python 3.10 SDK，配置的完整 8.0 安装不存在。
这是环境未匹配，同时 YJK 材料、荷载与结果映射本身仍有实现缺口，不能都归因于环境。
没有连接、重启或改动已有 YJK GUI，也没有混用不同版本 DLL。普通斜柱仍须实现真实双端连接，不能换成支撑。

## Next native acceptance sequence / 下一步原生验收顺序

1. Restore an isolated, matched PKPM ordinary-frame run with usable LL results;
   resolve the native foundation-interface hang before repeating physics tests.
   Match the YJK SDK, bundled Python and installed software version before import.
   / 先恢复可稳定读出活载结果的 PKPM 小框架；YJK 先配齐同版本软件与 SDK。
2. Pass frozen axial and bending/torsion references, then mass/self-weight and
   explicit floor/rigid-zone/construction settings. Open only the proven material
   and setting subset. / 再逐项验证轴向、弯扭刚度、质量自重及有效设置，只开放通过的子集。
3. Calibrate node six-component signs, full/partial line loads and span point
   loads, plus independent D/L/W case IDs. Preserve source IDs and positions;
   reject undocumented partial/point encodings instead of smearing them.
   / 校准六分量方向、各荷载位置和 D/L/W 工况，不改范围、不摊平点荷载。
4. Establish station coordinates, local axes, reversed endpoints, signed
   simultaneous forces, translations/rotations and direct reactions. Only then
   allow the strict linear-combination and equilibrium-recovery consumers.
   / 再校准截面位置、局部轴、端点反向及完整结果，之后才接通组合与反力恢复。
5. Exercise sloping beams and ordinary slanted columns through native two-end
   geometry readback and independent frame comparisons. / 最后以双端回读和独立比较验收坡梁、普通斜柱。

Candidate SDK writers and contract tests are implementation progress, not
native capability evidence. The production gates remain closed for all failed
or unverified capabilities; the full commercial refactor is not complete.

候选 SDK 写入器及契约测试属于实现进展，不属于原生能力验收。失败或未验收能力继续关闭，商业链尚未全部完成。

These results establish the stated subset only. They do not certify the 300-task
plan, native self-weight OFF, native slab OFF, arbitrary material constants,
inclined columns or reaction recovery.

上述证据只覆盖已说明子集，不代表300题、自重关闭、楼板关闭、任意材料常数、斜柱或反力恢复全部可用。
