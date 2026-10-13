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
retained without rerunning or rewriting it.

PKPM 底层牌号与几何编译同样拒绝显式材料常数、强度/钢筋覆盖及 A/I/J 等未映射属性；
尺寸采用明确正整数毫米，不四舍五入、不按大小猜单位。仅旧 V2.0 矩形 properties 尺寸按明确的
米约定兼容；新 V2.1 使用毫米 shape。重复定义、不对称或未知形状字段、非整数毫米及矛盾尺寸均拒绝。
原生标准截面库的力学属性等价性仍未验证，该路径仅保留编译能力。旧原生验收输入含 E，现会被更严格
门禁拒绝；历史证据保留，本轮不重跑也不改写历史输入。解锁需逐项完成原生写入回读及独立力学校核。

| Capability / 能力 | Evidence / 证据 |
|---|---|
| PKPM two-floor L-plan/setback, distinct beam sections / 两层 L 形退台、异梁截面 | Native JWS save/reopen preserved 6/4 nodes and 12/8 members; hidden SATWE execution returned 10 beams, 10 columns and signed station vectors / 原生回读及计算通过 |
| YJK individual joints, grids, beams, columns / 逐节点构件 | SDK declarations and converter contract test; native acceptance blocked by incomplete local installation / 声明与契约测试，原生环境未通过 |
| Signed native station vectors / 原始有符号截面力 | Retained separately from component envelopes; endpoint conventions remain unverified / 独立保存，端部符号约定待验收 |
| Arbitrary member/node loads, requested combinations / 任意构件节点荷载、指定组合 | Not yet enabled; reject unsupported inputs / 尚未放行，明确拒绝 |
| Sloping members, releases, offsets, springs, settlement / 斜构件、释放、偏心、弹簧、沉降 | Not yet enabled in these floor compilers / 尚未放行 |
| Explicit self-weight/diaphragm/rigid-zone/construction/P-delta controls / 显式自重楼板刚域施工与二阶设置 | Reject until native setting write/readback is accepted; unspecified legacy defaults are not proof of OFF / 写入回读未验收前拒绝，未声明不等于关闭 |
| PKPM reactions / 支座反力 | No direct reader in the installed ResultData interface; derived equilibrium requires signed endpoint vectors and verified axes/signs/offsets / 尚无直接读取，平衡恢复尚待端力约定验收 |

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
```

2026-10-13 evidence: PKPM `acceptance-commercial-pkpm-20261013-115755-ea18fbcc`
passed topology readback and solver result coverage in `sclaw_data/work`.
YJK attempts `acceptance-commercial-yjk-20261013-115925-fae10d8d` and
`acceptance-commercial-yjk-20261013-120011-f131697d` failed at SDK import
(`_cffi_backend` ABI/dependency and `ClrYJKAPI.dll` dependency respectively).
The configured full YJK installation path did not exist. No existing YJK project
was opened, attached, closed or modified.

These results establish the stated subset only. They do not certify the 300-task
plan, native self-weight OFF, native slab OFF, arbitrary material constants,
inclined columns or reaction recovery.

上述证据只覆盖已说明子集，不代表300题、自重关闭、楼板关闭、任意材料常数、斜柱或反力恢复全部可用。
