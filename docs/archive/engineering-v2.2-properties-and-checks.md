# V2.2 material, section and code-check acceptance

V2.2 keeps one physical model and adds typed design inputs. This is a capability
acceptance record, not a claim that every GB clause or every commercial solver
path is implemented. Historical paper data and frozen benchmark answers are not
rewritten.

## Persisted inputs

| Field | Meaning and units |
| --- | --- |
| `material.G` | Explicit shear modulus, MPa. OpenSees uses it; absent G is derived as E/(2(1+nu)). Effective settings record the source. |
| `material.design` | Declared `f`, `fv`, `fc`, `ft`, `ftk`, `Ec`, `Es`, `fy`, `fyv`, `fy_compression` in MPa; `ecu`, `alpha1`, `beta1` are dimensionless. Top-level `fy` retains its historical yield-strength meaning. |
| `element.design` | `l0`, `h0`, `crackWidthLimit` in mm; explicit stability, slenderness, width/thickness and serviceability coefficients. No field overrides solver results. |
| `element.design.reinforcement` | `{confirmed, values, source?}`. Areas are mm²; diameters, spacing and cover are mm. Migrating old flat fields does not invent confirmation. |
| `element.design.serviceability_result_keys` | Explicit result selections, e.g. `case:S` or `combination:SLS`. No inferred switch from an ultimate combination to serviceability. |
| `material.design.basis`, `element.design.basis` | Nonempty source/basis text indexed by field. A qualitative restraint statement does not invent a numerical stability coefficient. / 按字段保存输入依据；定性支承说明不能自动变成稳定系数。 |
| `story.load_area_m2` | Explicit actual loaded area. A regular 3D frame template records its known rectangular area; a commercial adapter cannot infer an irregular floor from the entire model bounding box. |
| `analysis_control.mass_source`, `mass_directions` | Adds `floor-seismic`; optional nonempty unique translational directions. The common mass assembler enforces engine/method applicability. |

Known historical top-level/extra design fields migrate once, with contradictions
rejected. Legacy section G migrates to its assigned material. Unassigned section
G remains recorded as historical evidence, and is not silently discarded.

The `floor-seismic` mass basis requires one elevated nodal level per declared
story. Sloping roofs or stepped floors sharing one story identifier must use
explicit nodal masses until their distribution is reviewed; a story mass is never
repeated for each height. Coordinate roundoff within the existing 1e-8 m level
tolerance does not create another floor. Time-history excitation requires actual
free translational mass in the requested direction; a massless direction is
rejected instead of returning a successful zero response.

## One section source

Section geometry is mm; A is m², I/J are m⁴ and elastic moduli Wx/Wz are m³.
Supported rectangle, circular, symmetric H/I and box geometric A/I must agree
with supplied values within a frozen serialization tolerance (relative 1e-6).
Net modulus cannot exceed gross modulus. Missing properties derive from geometry
with recorded method/fields. Circular J is exact; rectangular and thin-wall H
derived J carry the documented geometric approximation. Explicit noncircular J
is retained as the declared torsional property.

Uncalibrated standard catalog names cannot override numerical geometry. Templates
use explicit H×B×tw×tf dimensions, not the former inconsistent H catalog table.
Rolled profiles with fillets and other unverified geometry/property combinations
remain rejected until a reviewed mapping is provided.

Planar principal rotations 0/90/180/270 degrees are supported by consistently
swapping Iy/Iz in assembly, recovery and checking. General 2D rotations still need
a compatible 3D model. Weak-axis H-section shear is not synthesized from the
strong-axis web rule; the relevant reviewed shear data must be supplied.

## Real result consumption

Checks consume simultaneous signed station vectors tied to the run and model.
Demand/capacity outputs include their actual units (N, N·mm, MPa or mm), rather
than displaying a normalized ratio as if it were a physical quantity.

Service deflection normally uses the straight chord between physical member ends.
For an explicitly identified 2D standalone beam, a connected collinear chain without
interior restraints, releases, offsets or branches uses the whole support span;
subdivision at a point load does not halve its deflection reference length.
A cantilever uses the fixed-end translation/rotation reference. Frames and
continuous beams are not implicitly grouped this way. Rigid translation and equal
support settlement are excluded. The output explicitly labels its maximum as
sampled member recovery; it is not a continuous extremum proof or a new cracked,
creep or nonlinear RC stiffness model. Only an explicitly selected service case
supplies deflection and service moment. Missing data remains `input_required`.
An explicitly unselected result has an inapplicable deflection check; an unknown
service result key is rejected before checking, so a misspelling cannot hide all
serviceability checks. A canonical 2D beam needs only its active bending inertia;
this does not supply an invented out-of-plane stiffness for 3D recovery.

单跨梁在跨内荷载处拆成数段后，挠度仍按完整支承跨度计算；悬臂按固定端刚体运动
作为参照。只有拓扑、支承、局部轴与实际结果均满足条件时才采用该参照，不自动合并
框架或连续梁。使用工况必须属于当前运行，其他工况的挠度项不适用；拼错的工况不能
让验算被跳过。采样最大值始终保留采样标记。

## Editing confirmed conditions / 已确认条件的编辑

`query_model(includeSchema=true)` reads the actual Python V2 schema; no separate
design-field schema is invented for the agent. `edit_model` accepts nested values
and canonical dotted paths, typed numeric strings and serialized JSON containers.
It rejects unknown fields, contradictory paths and wrong design-field owners
atomically. Conversion readback must preserve accepted edits. A no-op returns
`changed:false, transaction:null`; it cannot reuse an earlier transaction as proof
of a successful write. Formal validation errors expose the rejected field paths.

`run_code_check` returns actual material/section/member write targets, model units,
explicit conversion scales and available result keys. Shared material/section
targets are grouped. Counts of incomplete checks are not counts of user questions.
For example, a checker-side S in mm³ writes `sections[id].properties.S` in m³;
104 cm³ is 0.000104 m³. Computed responses are read-only and cannot be filled by
declaring design inputs.

Ordinary user text updates go directly through model transactions. `review_input`
is for source evidence, proposes values without changing the model, and accepts
either an existing observed source ID or an explicit value, never both. Previously
absent optional fields must exist in the formal schema. Invalid review mappings
cannot save falsely resolved evidence or invalidate an existing analysis.

普通文字补参直接修改模型；材料强度、构件系数和截面属性分别写入其真实对象。
未知字段、冲突路径及转换后丢失字段都会拒绝整批修改，无变化不会复用旧事务。
校核缺项提供对象 ID、写入路径和单位；计算结果不能手填。证据复核只提出候选值，
非法映射不会保存为已解决记录，也不会清空已有计算。定性条件或未审定的截面名称
不能用来虚构系数、限值或整项合格结论。

Solid sections do not receive thin-plate local buckling checks. Zero reinforcement
spacing is a real inequality failure with measured and minimum values; it no
longer fabricates utilization 99. Full RC eccentric-compression capacity and
unverified biaxial/torsional interactions retain their explicit unsupported scope.

## Reproducible checks

`backend/tests/engineering-code-check-acceptance.mjs` performs ten native OpenSees
runs through the real analysis service and code-check worker. Its independent
references are fixed in the script before invoking the implementation:

- Steel beam stress and relative deflection: pass, fail and missing design strength.
- Steel axial column stability: pass, fail and missing stability coefficient.
- RC rectangular beam flexural capacity: pass, fail and missing reinforcement area.
- Common 20 mm support settlement, and principal 90-degree section rotation.
- Run provenance and demand/capacity units throughout the bridge.

The native tolerance is absolute 1e-8 plus relative 1e-8. Separate Python tests
verify explicit-G 3D torsion and equivalent 2D/3D principal-axis rotations.
Neither mocks nor these elastic examples substitute for commercial native
acceptance, all engineering combinations, or complete normative coverage.

`backend/tests/engineering-design-edit-acceptance.mjs` reproduces the two-member
10 m numerical beam through registered tools, real OpenSees, checking, queries
and bilingual reports. It separately verifies supplied partial conditions,
explicit additional synthetic conditions, an unavailable service key and real
overload. Its frozen elastic reference is 4.2672019444785825 mm with a 40 mm
declared L/250 limit. This is not certification of I20a catalogue data or complete
GB50017 coverage. / 该独立产品验收覆盖补参、编辑、重算、查询、校核及双语报告，
严格区分真实缺项与额外给定的测试条件，不作为型钢表或完整规范认证。

Run from the repository root after `npm --prefix backend run build`:

```powershell
$env:SCLAW_DATA_DIR = 'G:/StructureClaw-All/sclaw_data'
node backend/tests/engineering-code-check-acceptance.mjs
```
