# PKPM native repair evidence / PKPM 原生修复记录

This follow-up fixes two SDK load bugs and the batch-process lifecycle. It does
not open the formal V2 material/settings/result gates. All native runs used new
directories; existing models, paper fixtures and tags were not modified.

本轮修复了两个 SDK 荷载问题和批处理进程管理问题。正式 V2 的材料、设置及完整结果门禁
继续保留。所有原生试验使用新目录，没有改动已有模型、论文标答或标签。

## Fixed behavior / 已修复行为

- The native nodal gravity component occupies slot **0**, with downward positive.
  The former canonical `[Fx,Fy,Fz,Mx,My,Mz]` write put gravity in slot 2, producing
  a moment and lateral drift. Native displacement checks confirm downward and
  upward vertical loads. Other nodal component signs still require calibration.
  / 原生节点重力在第 0 槽，向下为正；旧写法把竖向力写到第 2 槽，实际产生弯矩和水平位移。
  已以真实计算验证正负竖向力，其他节点分量方向仍待校准。
- `Beam.GetLoad()` returns `nload` plus capacity-sized arrays. Entries after
  `nload` are not assignments. The previous writer interpreted those unused
  entries as existing loads and rejected fresh beams. Reading now respects the
  count and verifies the written assignments. Full-span vertical beam UDL passes
  independent axial-equilibrium checks.
  / 梁荷载接口返回有效数量及固定容量数组；有效数量之后不是荷载。读取现在只取有效范围，
  避免将未初始化内容误认为已有荷载；全跨均布荷载已通过独立平衡与位移比较。
- The launcher locks the installation across StructureClaw processes, detects
  another native batch before changing its directory selector, preserves
  `DirectorySet.conf` bytes, retains stdout/stderr, and stops only its own process
  tree on timeout or cancellation. Existing external directory changes are not
  overwritten. Native timeout runs verified that PKPMMain/WINSAT no longer remain
  running after their launcher exits.
  / 启动器增加跨进程锁、已有原生批处理检测、配置原字节恢复、日志保存及本次进程树清理。
  外部程序的新目录选择不会被覆盖；超时原生运行已验证不会遗留本次 PKPMMain/WINSAT。

## Native evidence / 原生证据

Raw input, reference, SDK readback, results and acceptance files remain under
`G:/StructureClaw-All/sclaw_data/work/<run>/`. The tracked compact manifest is
[`archive/acceptance-records-2026-10/pkpm-native-repair-20261013.json`](archive/acceptance-records-2026-10/pkpm-native-repair-20261013.json).

原始输入、参考、接口回读、计算结果和验收记录保存在上述独立运行目录；紧凑索引另行跟踪。

| Run | Evidence / 证据 |
|---|---|
| `acceptance-commercial-pkpm-20261013-161519-239251ba` | Existing two-story setback control fully solves and returns results. The installed SDK can read this installation's output; a version-warning string alone does not explain empty results. / 两层退台控制模型完整求解且结果可读，不能把空结果仅归因于版本警告。 |
| `pkpm-axial-20261013-162311-0f6700a5` | Old nodal wire fails the frozen vertical reference and produces lateral drift. / 旧节点编码未通过冻结竖向参考，并产生水平漂移。 |
| `pkpm-axial-20261013-162451-9957bb0f` | Corrected 1 kN gravity, four nodes, native-default controls: `uz=-2.7777778655035945e-7 m`. / 修正后四节点 1 kN 竖向位移通过。 |
| `pkpm-axial-20261013-162734-29b84251` | Same result with all candidate explicit settings except parameter 601. / 仅保留 601 原生默认值，其余候选设置显式写入，结果通过。 |
| `pkpm-axial-20261013-163047-1bd4820b` | Upward 500 N: `uz=+1.3888889327517973e-7 m` at all four nodes. / 向上 500 N 符号及大小通过。 |
| `pkpm-axial-20261013-163323-a49a98ed` | Four 4 m beams under 1 kN/m: each column carries 4 kN; `uz=-1.1111111462014378e-6 m`. / 全跨均布荷载的总量与位移通过。 |
| `pkpm-axial-20261013-163501-4a406499` | Two stories, eight nodes: floor displacements match `-2PL/EA` and `-3PL/EA`. / 两层八节点位移符合独立轴压解析解。 |
| `pkpm-axial-20261013-163854-08ca578d` | Two-story beam UDL: eight node translations, zero lateral drift, and signed column axial forces agree with independently frozen displacement/equilibrium references. / 两层梁均布荷载的八节点位移、零水平漂移及有符号柱轴力均通过独立参考。 |

The original `P=1 kN`, `L=3 m`, `A=0.36 m²`, `E=30000 MPa` reference and its
`1e-5` relative / `1e-11 m` absolute displacement tolerances remain unchanged.
New signed-load and multi-story references are saved before model creation.
These axial checks establish the stated C30/rectangular axial stiffness and
load subset only. They do not validate shear/torsion, density/self-weight,
arbitrary materials, floor assumptions or general member-result conventions.

原始轴压参考和位移容差未放宽。新增正负荷载与多层参考在创建模型前保存。
上述验收仅证明这组 C30 矩形截面的轴向刚度与已列荷载，不代表剪切、扭转、密度自重、
任意材料、楼板假定或通用构件结果约定通过。

## Remaining native obstruction / 尚存原生阻碍

`ProjectPara 601=60102` requests one-time loading. On this installed
SATWE2025R2.5 batch path, the controlled fixture repeatedly stops at foundation
interface generation. The corrected-load run
`pkpm-axial-20261013-162622-1661cc52` timed out; omitting only this parameter made
the same fixture finish with native construction simulation 1. The successful
diagnostic is **not** acceptance of one-time loading, and production does not
silently substitute construction simulation. The original failed runs remain.

本机批处理在显式一次性加载 `60102` 下可重复卡在基础接口输出；仅省略此参数则采用原生
“模拟施工 1”并成功。这是受控诊断差异，不是一次性加载验收，也没有在生产中静默替换设置。
原失败记录均保留。下一步应修复或更换经匹配验证的原生批处理计算路径，再认证显式设置。

## Reproduce / 复现

```powershell
& '<engineering-python>' backend/tests/analysis-pkpm-native-calibration.py --work-root '<new-work-root>' --cycle '<PKPM>/PkpmCycle/JWSCYCLE.exe' --timeout 60 --omit-setting 601
& '<engineering-python>' backend/tests/analysis-pkpm-native-calibration.py --work-root '<new-work-root>' --cycle '<PKPM>/PkpmCycle/JWSCYCLE.exe' --timeout 60 --omit-setting 601 --load-kn -0.5
& '<engineering-python>' backend/tests/analysis-pkpm-native-calibration.py --work-root '<new-work-root>' --cycle '<PKPM>/PkpmCycle/JWSCYCLE.exe' --timeout 60 --omit-setting 601 --stories 2 --load-pattern beam-uniform
```

The omitted-setting switch is diagnostic-only, not a production bypass.
`explicitControlsAccepted` remains false. Running without that switch retains
the original explicit one-time-loading attempt and its failure evidence.

省略设置的选项只用于诊断，不是生产后门；`explicitControlsAccepted` 继续为 false。
不传该选项则仍尝试原显式一次性加载条件，并保留失败证据。
# Follow-up: native enum correction / 后续：原生枚举修正

The earlier 60102 timeout diagnosis below is superseded by native evidence.
The installed SDK stores compact enums: frame `101=0`, RC `103=0`, steel
`103=2`, one-time loading `601=1`. The manual's 60102/10303 are option
identifiers, not stored values. The failure was in our adapter, not a proven
native inability. 先前 60102 超时结论已被新原生证据修正：适配器误把文档选项编号
写入原生枚举；不能据此认定软件不支持一次加载。

- `pkpm-axial-20261013-165556-52aba94a`: C30, no omitted settings, frozen
  axial displacement, signed column forces and zero lateral displacement pass.
- `pkpm-axial-20261013-170436-81467565`: Q355 E=206000 MPa, same gates pass.
- `pkpm-axial-20261013-171213-db68a175`: Q355 with zero native unit weights,
  zero slab thickness and slab deletion; the solved GOUJIAN.OUT reports zero
  slabs and every DL member force is zero. The independent LL axial gates pass.

All three WMASS.OUT reports identify actual one-time loading. Native generated
reports are no longer relabelled after solving; the runtime checks stored
material parameters without rewriting the solved input. 以上报告均显示实际一次加载；
运行后不再改写材料名称或模型参数，以读取和核对代替事后修饰。

These checks still do not certify full G/nu, transverse load signs, arbitrary
frame results or all requested outputs. 这些证据仍不等同于全量材料、方向和结果验收。

## Exact elastic materials and complete displacement vectors / 弹性材料与六自由度位移

The installed SATWE manual, printed page 236, supports user-material analysis.
The Python wrapper omits the native exported material interface. A read-only,
DLL-hash-bound bridge now uses `AddOneUserMaterial/GetUserMaterialByID` and
checks the generated `UserMaterial.SAT` consumed by the solver. No installed
DLL, SDK or independent API project is modified. Native custom-material code
design is not claimed; the original V2 retains its material grade/design data.
本机手册明确支持自定义材料分析；桥接缺少 Python 包装的原生接口，并校验求解输入材料文件，
没有修改软件安装或独立 API 项目，也不宣称原生自定义材料规范设计已经支持。

The bridge's audited x64 record is 208 bytes with twenty double slots, not
forty single-precision slots. The incorrect initial probe is preserved at
`pkpm-axial-20261013-174811-820a6263`; it timed out and was never accepted.
The actual DLL SHA256 is
`ca7a47b9006eb4b4f5f88c37014b0da5c090029de518a1d6ab69dbea0d2f6560`.
版本与布局经过校验；错误的初始探针及失败记录保留，不作为成功证据。

Fresh native acceptance runs under `G:/StructureClaw-All/sclaw_data/work`:

| Run | Independent check |
| --- | --- |
| `pkpm-axial-20261013-175043-fdf0cb4d` | Q355 E=206000 MPa, nu=.3, rectangular Timoshenko shear flexibility |
| `pkpm-axial-20261013-175235-7029eb3b` | C30 E=30000 MPa, nu=.2, same frozen transverse check |
| `pkpm-dof-20261013-174130-30199500` | Asymmetric four-cantilever nodal loads: all translations and rotations, including signed torsion |
| `pkpm-STD-086-20261013-180845-230511dd` | Production V2 L-shaped two-story input; all 96 free-node displacement/rotation components pass the separately frozen Timoshenko reference |
| `pkpm-MM-081-20261013-182128-6b4bbbf7` | Production V2 three-story setback input; all returned free-node displacement/rotation components pass its separately frozen Timoshenko reference |

The last two references are frozen before those candidate runs using the
independent test-only matrix implementation. Relative tolerance remains
1e-5 and displacement/rotation absolute tolerance 1e-11. Existing Euler
references remain unchanged and are retained separately; neither reference
is an independently reviewed native commercial scoring truth.
新参考在候选运行前冻结，未放宽容差；历史 Euler 参考保持原样，商业同引擎标答仍需独立审定。

The native user-material unit weight is independent of the built-in steel and
concrete weight parameters. `self_weight=false` therefore compiles a zero
user-material unit weight and records the unchanged source density. Merely
setting parameters 801/803 to zero leaves custom-material weight enabled;
the failed first STD-086 comparison exposed this and is retained.
关闭自重必须同时将本次分析的自定义材料容重设零，原始密度仍保留；仅改内置钢/砼容重不足以关闭自定义材料自重。

Native displacement records use `[ux,uy,rz,rx,ry,uz]`. NODEINDEX is partitioned
bottom-up by floor; DISP stores each case top-down. Every mapped translation
is checked against the public API's exact float32 m→mm→m transport. The
one-floor independent fixture and two-floor real fixture guard ordering,
unit and case mismatches. Missing support rotations remain explicit.
原生六分量顺序、逐层索引和工况经过交叉校验；缺少的支座转角不补零。

At this checkpoint, the fixed-base frame displacement chain is accepted;
support reactions, verified station semantics, combinations and the complete
three-rotation pin remain separate in-progress work. The ordinary native
column support enum is corrected from 1 (both fixed) to 3 (bottom hinged),
but this does not by itself prove that all three rotational DOFs are released.
此记录不等于商业整链完成；反力、站点语义、组合与完整三转动铰脚继续独立验收。
