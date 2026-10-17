import type { AppLocale } from '../shared/locale.js';
import type { SkillReportNarrativeInput } from '../shared/types/agent.js';
import { localize } from './plugin-helpers.js';
import { localizeCodeCheckLabel } from '../agent-skills/code-check/labels.js';
import { codeCheckUtilizationDisplay, codeCheckRowStatusLabel, codeCheckScopeLabel, renderCodeCheckSummaryMarkdown } from './report-template/code-check.js';
import { analysisData, asRecord } from './report-template/shared.js';
import { renderSeismicMarkdown } from './report-template/seismic.js';

function renderClauseTraceabilityMarkdown(
  traceability: Array<Record<string, unknown>>,
  locale: AppLocale,
): string[] {
  if (traceability.length === 0) {
    return [localize(locale, '- 无条文追溯数据', '- No clause traceability data')];
  }
  return traceability.slice(0, 8).map((row) => {
    const elementId = row['elementId'] ?? 'unknown';
    const check = localizeCodeCheckLabel(row['check'] ?? 'unknown', locale);
    const item = localizeCodeCheckLabel(row['item'], locale);
    const itemSuffix = item !== undefined && item !== null && String(item).trim().length > 0
      ? ` / ${String(item)}`
      : '';
    const clause = row['clause'] ?? '';
    const utilization = codeCheckUtilizationDisplay(row);
    const status = codeCheckRowStatusLabel(row, locale);
    return localize(
      locale,
      `- 范围 ${codeCheckScopeLabel(elementId, locale)} / ${String(check)}${itemSuffix} / ${String(clause)} / 利用率 ${String(utilization)} / ${String(status)}`,
      `- Scope ${codeCheckScopeLabel(elementId, locale)} / ${String(check)}${itemSuffix} / ${String(clause)} / utilization ${String(utilization)} / ${String(status)}`,
    );
  });
}

function renderControllingCasesMarkdown(
  controllingCases: Record<string, unknown>,
  locale: AppLocale,
): string[] {
  const batchControlCaseRaw = controllingCases['batchControlCase'];
  const batchControlCase = batchControlCaseRaw && typeof batchControlCaseRaw === 'object'
    ? batchControlCaseRaw as Record<string, unknown>
    : {};

  return [
    localize(locale, `- 批量位移控制工况: ${String(batchControlCase['displacement'] ?? 'N/A')}`, `- Governing displacement case: ${String(batchControlCase['displacement'] ?? 'N/A')}`),
    localize(locale, `- 批量轴力控制工况: ${String(batchControlCase['axialForce'] ?? 'N/A')}`, `- Governing axial-force case: ${String(batchControlCase['axialForce'] ?? 'N/A')}`),
    localize(locale, `- 批量剪力控制工况: ${String(batchControlCase['shearForce'] ?? 'N/A')}`, `- Governing shear-force case: ${String(batchControlCase['shearForce'] ?? 'N/A')}`),
    localize(locale, `- 批量弯矩控制工况: ${String(batchControlCase['moment'] ?? 'N/A')}`, `- Governing moment case: ${String(batchControlCase['moment'] ?? 'N/A')}`),
    localize(locale, `- 批量反力控制工况: ${String(batchControlCase['reaction'] ?? 'N/A')}`, `- Governing reaction case: ${String(batchControlCase['reaction'] ?? 'N/A')}`),
    localize(locale, `- 位移控制节点: ${String(controllingCases['controlNodeDisplacement'] ?? 'N/A')}`, `- Control displacement node: ${String(controllingCases['controlNodeDisplacement'] ?? 'N/A')}`),
    localize(locale, `- 轴力控制单元: ${String(controllingCases['controlElementAxialForce'] ?? 'N/A')}`, `- Control axial-force element: ${String(controllingCases['controlElementAxialForce'] ?? 'N/A')}`),
    localize(locale, `- 剪力控制单元: ${String(controllingCases['controlElementShearForce'] ?? 'N/A')}`, `- Control shear-force element: ${String(controllingCases['controlElementShearForce'] ?? 'N/A')}`),
    localize(locale, `- 弯矩控制单元: ${String(controllingCases['controlElementMoment'] ?? 'N/A')}`, `- Control moment element: ${String(controllingCases['controlElementMoment'] ?? 'N/A')}`),
    localize(locale, `- 反力控制节点: ${String(controllingCases['controlNodeReaction'] ?? 'N/A')}`, `- Control reaction node: ${String(controllingCases['controlNodeReaction'] ?? 'N/A')}`),
  ];
}

function renderControlNodeDisplacementMarkdown(input: SkillReportNarrativeInput): string[] {
  const data = analysisData(input);
  const displacements = asRecord(data['displacements']);
  const envelope = asRecord(data['envelope']);
  const summary = asRecord(data['summary']);
  const controlNodeId = String(
    input.controllingCases['controlNodeDisplacement']
      ?? envelope['controlNodeDisplacement']
      ?? summary['maxDisplacementNode']
      ?? '',
  ).trim();
  if (!controlNodeId) {
    return [];
  }

  const response = asRecord(displacements[controlNodeId]);
  const components = ['ux', 'uy', 'uz']
    .filter((key) => typeof response[key] === 'number' && Number.isFinite(response[key]))
    .map((key) => `${key}=${String(response[key])}`);
  if (components.length === 0) {
    return [];
  }

  const model = asRecord(input.normalizedModel);
  const nodes = Array.isArray(model['nodes']) ? model['nodes'].map(asRecord) : [];
  const controlNode = nodes.find((node) => String(node['id'] ?? '') === controlNodeId);
  const coordinates = controlNode
    ? ['x', 'y', 'z']
      .filter((key) => typeof controlNode[key] === 'number' && Number.isFinite(controlNode[key]))
      .map((key) => `${key}=${String(controlNode[key])}`)
    : [];
  const meta = asRecord(data['meta']);
  const units = asRecord(meta['units']);
  const unit = String(units['displacement'] ?? '').trim();
  const coordinateText = coordinates.length > 0
    ? localize(input.locale, `，全局坐标 (${coordinates.join(', ')})`, ` at global coordinates (${coordinates.join(', ')})`)
    : '';
  const unitText = unit ? ` ${unit}` : '';

  return [
    localize(
      input.locale,
      `- 控制节点位移响应: 节点 ${controlNodeId}${coordinateText}，${components.join(', ')}${unitText}`,
      `- Control-node displacement response: node ${controlNodeId}${coordinateText}, ${components.join(', ')}${unitText}`,
    ),
  ];
}

/** Result units reported by the analysis engine (meta.units of the run or of its first case). */
function analysisUnits(input: SkillReportNarrativeInput): Record<string, unknown> {
  const data = analysisData(input);
  const own = asRecord(asRecord(data['meta'])['units']);
  if (Object.keys(own).length > 0) return own;
  const results = Object.values(asRecord(data['results'])).map(asRecord);
  return results.map((result) => asRecord(asRecord(result['meta'])['units'])).find((units) => Object.keys(units).length > 0) ?? {};
}

/** Key-metric value with the engine unit when one is reported (never a guessed unit). */
function metricText(value: unknown, unit: unknown): string {
  if (value === undefined || value === null) return 'N/A';
  const unitText = typeof unit === 'string' && unit.trim().length > 0 ? ` ${unit.trim()}` : '';
  return `${String(value)}${unitText}`;
}

export function buildDefaultReportNarrative(input: SkillReportNarrativeInput): string {
  const { locale, message, analysisType, analysisSuccess, codeCheckText, summary, keyMetrics, clauseTraceability, controllingCases } = input;
  const units = analysisUnits(input);
  const displacement = metricText(keyMetrics.maxAbsDisplacement, units['displacement']);
  const axialForce = metricText(keyMetrics.maxAbsAxialForce, units['force']);
  const shearForce = metricText(keyMetrics.maxAbsShearForce, units['force']);
  const moment = metricText(keyMetrics.maxAbsMoment, units['moment']);
  const reaction = metricText(keyMetrics.maxAbsReaction, units['force']);

  return [
    localize(locale, '# StructureClaw 计算报告', '# StructureClaw Calculation Report'),
    '',
    localize(locale, '## 目录', '## Contents'),
    localize(locale, '1. 执行摘要', '1. Executive Summary'),
    localize(locale, '2. 关键指标', '2. Key Metrics'),
    localize(locale, '3. 条文追溯', '3. Clause Traceability'),
    localize(locale, '4. 控制工况', '4. Governing Cases'),
    '',
    localize(locale, '## 执行摘要', '## Executive Summary'),
    localize(locale, `- 用户意图：${message}`, `- User intent: ${message}`),
    localize(locale, `- 分析类型：${analysisType}`, `- Analysis type: ${analysisType}`),
    localize(locale, `- 分析结果：${analysisSuccess ? '成功' : '失败'}`, `- Analysis result: ${analysisSuccess ? 'Success' : 'Failure'}`),
    localize(locale, `- 规范校核：${codeCheckText}`, `- Code checks: ${codeCheckText}`),
    '',
    summary,
    '',
    localize(locale, '## 关键指标', '## Key Metrics'),
    localize(locale, `- 最大位移: ${displacement}`, `- Max displacement: ${displacement}`),
    ...renderControlNodeDisplacementMarkdown(input),
    localize(locale, `- 最大轴力: ${axialForce}`, `- Max axial force: ${axialForce}`),
    localize(locale, `- 最大剪力: ${shearForce}`, `- Max shear force: ${shearForce}`),
    localize(locale, `- 最大弯矩: ${moment}`, `- Max moment: ${moment}`),
    localize(locale, `- 最大反力: ${reaction}`, `- Max reaction: ${reaction}`),
    localize(locale, `- 校核通过率: ${String(keyMetrics.codeCheckPassRate ?? 'N/A')}`, `- Code-check pass rate: ${String(keyMetrics.codeCheckPassRate ?? 'N/A')}`),
    ...renderCodeCheckSummaryMarkdown(input),
    ...renderSeismicMarkdown(input),
    '',
    localize(locale, '## 条文追溯', '## Clause Traceability'),
    ...renderClauseTraceabilityMarkdown(clauseTraceability, locale),
    '',
    localize(locale, '## 控制工况', '## Governing Cases'),
    ...renderControllingCasesMarkdown(controllingCases, locale),
  ].join('\n');
}
