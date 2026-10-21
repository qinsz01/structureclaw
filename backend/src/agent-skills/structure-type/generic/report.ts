import type { SkillReportNarrativeInput } from '../../../shared/types/agent.js';
import { appliedLoadTotals } from '../../../engineering/model-physics.js';
import { isRecord } from '../../../engineering/model-state.js';

const asRecord = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/** Describe model facts and solver results without inferring supports, units or compliance. */
export function buildGenericReportNarrative(input: SkillReportNarrativeInput): string {
  const zh = input.locale === 'zh';
  const text = (en: string, cn: string) => zh ? cn : en;
  const model = asRecord(input.normalizedModel);
  const analysis = asRecord(input.analysis);
  const data = asRecord(analysis.data);
  const results = Object.values(asRecord(analysis.results)).map(asRecord);
  const unitSources = [data, analysis, ...results.map(result => asRecord(result.data)), ...results];
  const units = unitSources.map(source => asRecord(asRecord(source.meta).units)).find(value => Object.keys(value).length) ?? {};
  const format = (value: number) => Number(value.toPrecision(8)).toString();
  const lines = [
    text('The generic structural workflow summary is complete.', '已完成通用结构流程的分析汇总。'),
    text(`Analysis type: ${input.analysisType}.`, `分析类型：${input.analysisType}。`),
    text(`Execution status: ${input.analysisSuccess ? 'success' : 'failed'}.`, `执行状态：${input.analysisSuccess ? '成功' : '失败'}。`),
    input.summary,
  ];
  const nodes = Array.isArray(model.nodes) ? model.nodes.map(asRecord) : [];
  const supports = nodes.filter(node => Array.isArray(node.restraints) && node.restraints.some(value => value === true));
  if (nodes.length) {
    lines.push('', text('Supports (restrained global DOFs):', '支承（受约束的全局自由度）：'));
    for (const node of supports) {
      const dofs = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].filter((_, i) => (node.restraints as unknown[])[i] === true);
      lines.push(`- ${String(node.id)}: ${dofs.join(', ')}`);
    }
    if (!supports.length) lines.push(text('- None recorded.', '- 模型未记录支承。'));
  }
  const totals = appliedLoadTotals(model);
  if (Object.keys(totals).length) {
    lines.push('', text('Explicit applied-load totals (global Fx, Fy, Fz; kN; self-weight excluded):', '显式施加荷载合计（全局 Fx、Fy、Fz；kN；不含自重）：'));
    for (const [id, total] of Object.entries(totals)) lines.push(`- ${id}: (${total.map(format).join(', ')})`);
  }
  const placeholder = asRecord(model.metadata).stiffnessPlaceholder;
  const governing = asRecord(input.controllingCases.batchControlCase);
  const metrics = [
    ['maxAbsDisplacement', 'displacement', 'displacement', 'controlNodeDisplacement', 'Maximum displacement', '最大位移'],
    ['maxAbsAxialForce', 'force', 'axialForce', 'controlElementAxialForce', 'Maximum absolute axial force', '最大绝对轴力'],
    ['maxAbsShearForce', 'force', 'shearForce', 'controlElementShearForce', 'Maximum absolute shear force', '最大绝对剪力'],
    ['maxAbsMoment', 'moment', 'moment', 'controlElementMoment', 'Maximum absolute moment', '最大绝对弯矩'],
    ['maxAbsReaction', 'force', 'reaction', 'controlNodeReaction', 'Maximum absolute reaction', '最大绝对反力'],
  ];
  lines.push('', text('Governing results:', '控制结果：'));
  for (const [key, unitKey, caseKey, entityKey, en, cn] of metrics) {
    const value = input.keyMetrics[key!];
    if (typeof value !== 'number' || !Number.isFinite(value) || placeholder && key === 'maxAbsDisplacement') continue;
    const unit = typeof units[unitKey!] === 'string' ? ` ${units[unitKey!]}` : '';
    const location = [governing[caseKey!], input.controllingCases[entityKey!]].filter(value => value !== undefined && value !== null).join(' / ');
    lines.push(`- ${text(en!, cn!)}: ${format(value)}${unit}${location ? ` (${location})` : ''}`);
  }
  if (placeholder) lines.push(text('Unit stiffness was used for a force-only request; physical displacements are not reported.', '仅内力请求采用单位刚度占位，不报告实际位移。'));
  if (input.codeCheckText?.trim()) lines.push('', input.codeCheckText);
  return lines.filter(line => line !== undefined).join('\n');
}
