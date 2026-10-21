import type { AppLocale } from '../../../shared/locale.js';

const STRUCTURE_MODEL_V2_TEMPLATE = JSON.stringify({
  schema_version: '2.2.0',
  unit_system: 'SI',
  coordinate_system: {
    semantics: 'global-z-up',
    version: 1,
    dimension: '2d',
    plane: 'xz',
    dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
  },
  nodes: [
    { id: 'N1', x: 0, y: 0, z: 0, restraints: [true, true, true, true, true, true] },
    { id: 'N2', x: 10, y: 0, z: 0 },
  ],
  elements: [
    { id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: 'MAT1', section: 'SEC1' },
  ],
  materials: [
    { id: 'MAT1', name: 'Steel_Q235', E: 206000, nu: 0.3, rho: 7850, fy: 235 },
  ],
  sections: [
    { id: 'SEC1', name: 'Rect_200x400', type: 'rectangular', shape: { kind: 'rectangular', B: 200, H: 400 } },
  ],
  load_cases: [
    { id: 'LC1', type: 'other', loads: [
      { type: 'nodal', node: 'N2', fx: 0, fy: 0, fz: -10, mx: 0, my: 0, mz: 0 },
      { type: 'distributed', element: 'E1', wx: 0, wy: 0, wz: -10 },
    ] },
  ],
  load_combinations: [
    { id: 'COMB1', factors: { LC1: 1.0 } },
  ],
});

const COMMON_CONSTRAINTS_EN = [
  'Model physical roles: beams carry transverse span loads, columns carry storeys vertically, truss/brace members are axial-only and hinged. Orientation alone does not turn a chord or arch into a column; document intentional exceptions in element.metadata.roleReason. Give storey elevations in stories when storeys exist and declare each section purpose (beam/column/brace/other).',
  'End releases describe actual joints in element-local axes (releases.i/j.ry/rz), not supports. Axial truss/brace members are already hinged: omit additional rotational releases. Declare rotation_angle where section orientation matters. Do not release frame joints unless requested. A pin restrains translations, a roller restrains its stated direction, and a fixed support restrains all active DOFs. Verify the supported stiffness has no mechanism.',
  'Section evidence: do not treat a remembered section-table value as confirmed input. Return missing_fields together for unsupported designations or pending confirmation; use confirmed geometry or evidenced properties only. Only the shared runtime may supply labelled unit stiffness for an eligible force-only request. Partly specified real sections require the missing properties: never invent a unit section for an omitted brace or write placeholder provenance/metadata yourself.',
  'Load directions are signed physical vectors: preserve global components as given, convert gravity-positive magnitudes to negative global Z, and rotate element-local components through the member axes. Preserve every load and its target, case, interval and position. Never infer a global force from the apparent drawing direction.',
  'Output StructureModel V2 with schema_version exactly "2.2.0" and unit_system exactly "SI".',
  'Always output the complete coordinate_system object. Use dimension="2d" and plane="xz" for a 2D model; use dimension="3d" and plane=null for a 3D model. Never infer or omit this declaration.',
  'Use global-z-up coordinates: x is the main horizontal span, z is vertical height, and y is the out-of-plane direction. Put 2D structures in the x-z plane with y=0.',
  'Node restraints must contain exactly six booleans in [ux,uy,uz,rx,ry,rz] order, where true means restrained and false means free. A simply-supported X-Z beam uses a pinned left support [true,true,true,false,false,false] and an X-direction roller at the right support [false,true,true,false,false,false].',
  'Coordinates and member load positions are meters, point forces are kN, and distributed member loads are kN/m. Section geometry and member design lengths are mm; E/G and design stresses are MPa; A is m2 and I/J are m4. Never output N or N/m load values and never multiply kN values by 1000.',
  'Use the template hierarchy and declared V2.2 fields. load_case.type must be dead, live, wind, seismic, or other. Preserve explicit material.G, material.design strengths, element.design coefficients and confirmed reinforcement. Only explicitly designated service result keys belong in element.design.serviceability_result_keys; do not label an ultimate combination as serviceability.',
  'Copy confirmed section records without recomputing their values. When the user supplies geometry only, output shape only and OMIT properties completely: deterministic geometry code computes A/I/J. Do not add rounded numerical properties alongside shape. Numerical properties explicitly provided by the user must be preserved and validated, never discarded to hide a conflict.',
  'Keep one section source: explicit geometry is validated and derives properties; explicit properties must agree with geometry when both are given. Do not invent standard_steel_name for a user-defined H section. A section designation is a label: HN300×150×6.5×9 means H×B×tw×tf plate geometry in mm (sharp corners); a designation without plate thicknesses needs tw/tf or complete properties.',
  'Prohibited alternate field names: material_id->material, section_id->section, coordinates->x/y/z, boundary_conditions->restraints, elastic_modulus->E, poisson_ratio->nu, density->rho, yield_strength->fy.',
  'Create explicit nodes at physical supports, joints, member intersections and geometry break points. Internal load and output positions do not require changing physical member IDs.',
  'Before output, check the total applied load against the user request. Do not apply the same physical load twice as both nodal and distributed loads.',
  'Keep physical members intact. Use type=point, element, position in metres from the i end, and fx/fy/fz/mx/my/mz for an internal concentrated load. Distributed loads use wx/wy/wz and optional start/end distances in metres. The analysis compiler creates its own mesh. Reference frames are global or element-local. Preserve signed components; gravity-positive draft values map to negative global Z.',
  'Do not invent missing geometry, restraints, materials or member sections. Return {"missing_fields":[...]} if essential data is missing or contradictory. Preserve each member type, property assignment, release, offset and local-axis definition. Keep attachment page/entity/row references in metadata.inputEvidence; the drawing is evidence, not a numeric answer.',
  'If confirmed parameters contain seismicMemberEvidence or seismicWorkflow.memberEvidence, attach the provided structured member evidence to the matching element as element fields, metadata, or extra using keys such as seismicCapacity, capacityDesign, strongShearWeakBending, shearCompression, jointCore, wallData, boundaryElement, or steelSeismicDetailing; do not summarize it as prose and do not decide code-check pass/fail.',
];

const COMMON_CONSTRAINTS_ZH = [
  '按物理功能声明构件角色：梁承受跨向横向荷载，柱承担楼层竖向传力，truss/brace为纯轴力铰接杆；不能仅凭朝向把弦杆或拱改成柱。有意例外在element.metadata.roleReason说明。存在楼层时在stories写明标高，并声明截面purpose（beam/column/brace/other）。',
  '端部释放表示真实节点连接，使用构件局部轴releases.i/j.ry/rz，不是支座。truss/brace纯轴力杆本身已铰接，不另加转动释放。截面方向有影响时声明rotation_angle；没有依据不得释放框架节点。铰支约束平移，滚支约束指定方向，固支约束全部有效自由度。检查支承后的刚度是否存在机构。',
  '截面证据规则：记忆的截面表值不是已确认输入。无法据实定义的型号或尚待确认的属性应与其他缺项一起返回missing_fields，只用已确认几何或有依据的属性。只有共享程序可为符合条件的仅内力请求加入单位刚度；部分真实截面已给出时须补齐其余属性，不得自行给缺失斜撑编造单位截面或写占位来源、元数据。',
  '荷载方向必须保持物理符号：原样保留全局分量，gravity正幅值转换为全局负Z，构件局部分量通过构件局部轴旋转。保留每个荷载的目标、工况、区间和位置，不能凭图面朝向猜全局力。',
  '输出 StructureModel V2，schema_version 必须是 "2.2.0"，unit_system 必须是 "SI"。',
  '必须完整输出 coordinate_system。二维模型使用 dimension="2d"、plane="xz"；三维模型使用 dimension="3d"、plane=null。不得省略该声明或留给下游推断。',
  '使用 global-z-up 坐标：x 为主要水平跨度，z 为竖向高度，y 为平面外方向。二维结构应位于 x-z 平面，y=0。',
  '节点 restraints 必须严格包含 6 个布尔值，顺序为 [ux,uy,uz,rx,ry,rz]；true 表示约束，false 表示自由。X-Z 平面简支梁左端使用铰支座 [true,true,true,false,false,false]，右端使用沿 X 方向滚动的支座 [false,true,true,false,false,false]。',
  '坐标及构件荷载位置使用 m，集中力使用 kN，构件均布荷载使用 kN/m；截面几何与构件设计长度使用 mm；E/G与设计应力为MPa；A为m2，I/J为m4。不要输出 N 或 N/m 荷载，也不要把 kN 数值乘以 1000。',
  '使用模板层级及已声明的V2.2字段。load_case.type 只能是 dead/live/wind/seismic/other。保留显式material.G、material.design设计强度、element.design验算参数和已确认配筋。只有明确指定的正常使用结果键才能进入element.design.serviceability_result_keys，不得把承载力组合当作正常使用组合。',
  '原样保留已确认截面记录，不要重新计算属性。用户仅给几何时只输出shape，完全省略properties，由确定性几何程序计算A/I/J，禁止同时写入心算或四舍五入的属性。用户明确给出的数值属性必须保留并校验，不得为了消除冲突而丢弃。',
  '保持一个截面来源：显式几何会校验并推导属性，两者同时提供必须一致。自定义H截面不得虚构standard_steel_name。截面型号只是名称：HN300×150×6.5×9 表示 H×B×tw×tf 板件几何（mm，无圆角）；缺少板厚的型号需补充 tw/tf 或完整属性。',
  '禁止替代字段名：material_id->material, section_id->section, coordinates->x/y/z, boundary_conditions->restraints, elastic_modulus->E, poisson_ratio->nu, density->rho, yield_strength->fy。',
  '在物理支座、连接、构件交点和几何转折处建立显式节点；跨内荷载与结果采样点无需改变物理构件ID。',
  '输出前核对总施加荷载与用户描述是否一致。不要把同一个物理荷载同时作为节点荷载和构件均布荷载重复施加。',
  '保持物理构件完整。跨内集中荷载用 type=point、element、从i端起的position米及fx/fy/fz/mx/my/mz；分布荷载用wx/wy/wz及可选start/end米。分析编译器负责细分网格。reference_frame只能是global或element-local。保留带符号分量，草稿gravity正值对应全局负Z。',
  '不得猜测缺失的几何、约束、材料或逐构件截面；关键数据缺失或冲突时返回{"missing_fields":[...]}。保留构件类型、属性分组、释放、偏心及局部轴。附件页码/实体/表格行来源保存在metadata.inputEvidence；图纸是建模依据而不是数值答案。',
  '如果已确认参数包含 seismicMemberEvidence 或 seismicWorkflow.memberEvidence，必须把已提供的构件抗震证据挂到匹配 element 的字段、metadata 或 extra 中，并保留 seismicCapacity、capacityDesign、strongShearWeakBending、shearCompression、jointCore、wallData、boundaryElement、steelSeismicDetailing 等结构化键；不要写成自然语言备注，也不要由 LLM 判断条文通过或失败。',
];

export function getStructureModelTemplate(): string {
  return STRUCTURE_MODEL_V2_TEMPLATE;
}

export function getCommonConstraints(locale: AppLocale): string[] {
  return locale === 'zh' ? COMMON_CONSTRAINTS_ZH : COMMON_CONSTRAINTS_EN;
}
