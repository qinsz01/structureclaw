import type { AppLocale } from '../shared/locale.js';
import { currentRunPolicy } from '../runtime/run-context.js';
import type { RunPolicy } from '../runtime/run-policy.js';

/** Principle-level guidance shared by extraction, building and delivery. Never a selectable skill. */
const TOPICS = {
  loads: {
    en: 'Keep every load, case, target, sign and unit. Distinguish nodal forces (kN), member loads (kN/m) and area loads (kN/m²); transfer floor loads once and verify the total. Self-weight is included only when requested. Wind, snow, crane and temperature actions need their physical direction and supplied basis.',
    zh: '保留全部荷载、工况、目标、符号和单位。区分节点力(kN)、杆件线荷载(kN/m)和面荷载(kN/m²)；楼面荷载只传递一次并核对总量。仅按要求计入自重。风、雪、吊车和温度作用须有明确物理方向和给定依据。',
  },
  boundaries: {
    en: 'Supports restrain physical degrees of freedom; releases describe member-end freedom. Keep their axes explicit and check connectivity and stability. A pin transfers forces without fixing rotations; a roller leaves its declared translation free. Do not infer member design lengths from mesh lengths.',
    zh: '支座约束物理自由度，端释放描述构件端部自由度。明确坐标轴并检查连接与稳定性。铰支座传力而不约束转动，滚动支座保留指定平动自由度。不得将网格长度当作设计计算长度。',
  },
  combinations: {
    en: 'Keep load cases and factored combinations separate. Preserve supplied factors and distinguish ultimate from serviceability results; do not invent factors or count the same action twice.',
    zh: '区分荷载工况与带系数组合，保留给定系数并区分承载力与正常使用结果；不编造系数，不重复计入同一作用。',
  },
  input: {
    en: 'Preserve attachment evidence, stable IDs and units from DXF, tables, images and PDFs. Resolve plan/elevation and axis meaning before mapping coordinates; pixels are never engineering dimensions. Ask together for genuinely unreadable or missing physics.',
    zh: '保留 DXF、表格、图片及 PDF 中的附件证据、稳定 ID 和单位。先确认平立面及轴向语义再映射坐标，像素不能作为工程尺寸。真正不可读或缺失的物理信息应一次问全。',
  },
  validation: {
    en: 'Before analysis check geometry, referenced records, connectivity, supports, section/material evidence, units and load totals. Report unsupported capability or remaining errors honestly rather than substituting a different structure or engine.',
    zh: '分析前核对几何、记录引用、连接、支座、截面和材料依据、单位及荷载总量。能力不支持或仍有错误时如实报告，不能替换结构或引擎。',
  },
  results: {
    en: 'Summarise supports, applied totals, reactions and governing signed results with case, member, position and units. Use only the current model/run. Forces from placeholder stiffness cannot justify displacements or design. Generate reports only when requested; distinguish diagrams from numerical evidence.',
    zh: '汇总支座、荷载总量、反力及控制有符号结果，标注工况、构件、位置和单位。只使用当前模型与运行结果。占位刚度的内力不能用于位移或设计判断。仅按请求生成报告，区分图示与数值证据。',
  },
} as const;

export type KnowledgeTopic = keyof typeof TOPICS;

export function engineeringKnowledge(locale: AppLocale, topics: readonly KnowledgeTopic[], policy: Pick<RunPolicy, 'knowledge'> | null | undefined = currentRunPolicy()): string {
  if (policy?.knowledge === 'disabled') return '';
  return topics.map(topic => TOPICS[topic][locale]).join('\n');
}
