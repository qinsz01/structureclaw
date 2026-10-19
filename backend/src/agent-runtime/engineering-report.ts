import { buildReportDomainArtifacts } from '../agent-skills/report-export/entry.js';
import { buildDefaultReportNarrative } from './report-template.js';
import type { SkillReportNarrativeInput } from '../shared/types/agent.js';
import { checkDesignValues, designValueLines, formatCheckSummary } from '../engineering/code-checks.js';
import { reportResultRows, resultTableMarkdown } from '../engineering/result-data.js';
import { isRecord, modelHash } from '../engineering/model-state.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runPkpmCalcbook } from '../agent-skills/report-export/calculation-book/pkpm-calcbook/runner.js';
import { resultEngine } from '../engineering/result-data.js';
import { sectionAssumptions } from '../engineering/section-assumptions.js';

interface EngineeringReportInput {
  message: string;
  analysisType: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
  normalizedModel?: unknown;
  analysis: unknown;
  codeCheck?: unknown;
  locale: 'zh' | 'en';
  reportSource?: string;
  /** 'off' (ablation, docs/ablation.md) skips the report ↔ model/run/check provenance checks and marks meta. */
  evidenceBinding?: 'on' | 'off';
}

/** A single structured source for HTTP, chat and public-tool reports. */
export function prepareEngineeringReport(input: EngineeringReportInput) {
  const analysis = isRecord(input.analysis) ? input.analysis : {};
  const check = isRecord(input.codeCheck) ? input.codeCheck : {};
  const meta = isRecord(analysis.meta) ? analysis.meta : {};
  const checkMeta = isRecord(check.meta) ? check.meta : {};
  const bound = input.evidenceBinding !== 'off';
  if (bound && isRecord(input.normalizedModel) && meta.modelHash && meta.modelHash !== modelHash(input.normalizedModel)) {
    throw new Error('REPORT_MODEL_MISMATCH / 报告模型与运行不一致');
  }
  if (bound && analysis.runId && Object.keys(check).length &&
    (checkMeta.runId !== analysis.runId || (meta.modelHash && checkMeta.modelHash !== meta.modelHash))) {
    throw new Error('REPORT_DESIGN_RUN_MISMATCH / 校核结果不属于本次运行');
  }
  const analysisSuccess = analysis.success === true;
  const failedNativeChecks = isRecord(check.summary) && typeof check.summary.failed === 'number' ? check.summary.failed : 0;
  const codeCheckText = check.designMode === 'required-reinforcement' && check.completionStatus === 'complete'
    ? input.locale === 'zh'
      ? `所需配筋计算已完成${failedNativeChecks > 0 ? `，${failedNativeChecks} 项原生检查未通过` : ''}，未验算已有配筋`
      : `Required reinforcement calculated${failedNativeChecks > 0 ? `; ${failedNativeChecks} native checks failed` : ''}; installed reinforcement was not checked`
    : formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, input.locale);
  const summary = input.locale === 'zh'
    ? `分析类型 ${input.analysisType}，分析${analysisSuccess ? '成功' : '失败'}，${codeCheckText}。`
    : `Analysis type ${input.analysisType}; analysis ${analysisSuccess ? 'succeeded' : 'failed'}; ${codeCheckText}.`;
  const artifacts = buildReportDomainArtifacts({ normalizedModel: input.normalizedModel,
    postprocessedResult: input.analysis, codeCheckResult: input.codeCheck });
  const narrativeInput: SkillReportNarrativeInput = { ...input, ...artifacts, analysisSuccess, codeCheckText, summary };
  const json: Record<string, unknown> = { reportSchemaVersion: '1.1.0', intent: input.message,
    analysisType: input.analysisType, summary, ...artifacts, normalizedModel: input.normalizedModel,
    analysis: input.analysis, codeCheck: input.codeCheck, resultSets: reportResultRows(input.analysis),
    requestedQuantities: analysis.requestedQuantities ?? [], requestedSelection: analysis.requestedSelection, generatedAt: new Date().toISOString(),
    meta: { reportSkillId: 'report-export-builtin', reportSource: input.reportSource, runId: analysis.runId, source: meta,
      selectedResultKey: analysis.selectedResultKey, resultKeys: Object.keys(isRecord(analysis.results) ? analysis.results : {}),
      ...(bound ? {} : { evidenceBinding: 'off' as const }) } };
  return { input, narrativeInput, summary, json };
}

export function finishEngineeringReport(prepared: ReturnType<typeof prepareEngineeringReport>, narrative?: string) {
  const { input, summary, json } = prepared;
  const analysis = isRecord(input.analysis) ? input.analysis : {};
  const check = isRecord(input.codeCheck) ? input.codeCheck : undefined;
  const limitedChecks = check && isRecord(check.checkScope) && check.checkScope.limited === true;
  const unverified = check && (check.completionStatus !== 'complete' || check.complianceStatus === 'fail' || limitedChecks);
  let markdown = !unverified && narrative ? narrative : buildDefaultReportNarrative(prepared.narrativeInput);
  markdown += resultTableMarkdown(input.analysis, input.locale);
  const sectionNotes = sectionAssumptions(input.normalizedModel);
  if (sectionNotes.length) {
    json.sectionAssumptions = sectionNotes;
    markdown += `\n\n${input.locale === 'zh' ? '截面取值及假定' : 'Section values and assumptions'}:\n\n`
      + sectionNotes.map(row => `- ${row.message[input.locale]}`).join('\n') + '\n';
  }
  if (limitedChecks) markdown += input.locale === 'zh'
    ? '\n本报告仅包含用户明确选择的专项校核；未请求项目未校核，不构成完整设计合格结论。\n'
    : '\nThis report covers only the explicitly requested checks. Unrequested checks were not performed; this does not establish complete design compliance.\n';
  const designValues = check ? designValueLines(checkDesignValues(check), input.locale) : [];
  if (designValues.length) markdown += input.locale === 'zh'
    ? `\n规范校核采用的规范及几何确定值（模型中给出的数值优先）：\n\n${designValues.join('\n')}\n`
    : `\nCode- and geometry-determined values used by the code check (values given in the model take precedence):\n\n${designValues.join('\n')}\n`;
  if (reportResultRows(input.analysis).some(row => row.capabilityStatus === 'partial')) markdown += input.locale === 'zh'
    ? '\n本次运行包含部分能力或估算结果；不能视为原结构完整分析或全面规范合格。\n'
    : '\nThis run includes partial capabilities or estimates; it does not establish complete analysis or overall code compliance.\n';
  if (analysis.runId) markdown += input.locale === 'zh'
    ? `\n\n计算来源：运行 ${String(analysis.runId)}；结果 ${String(analysis.selectedResultKey ?? 'default')}。\n`
    : `\n\nCalculation source: run ${String(analysis.runId)}; result ${String(analysis.selectedResultKey ?? 'default')}.\n`;
  if (isRecord(analysis.requestedSelection)) {
    const selection = analysis.requestedSelection;
    const tags = [selection.nodeId ? `${input.locale === 'zh' ? '节点' : 'Node'} ${String(selection.nodeId)}` : undefined,
      selection.elementId ? `${input.locale === 'zh' ? '构件' : 'Member'} ${String(selection.elementId)}` : undefined,
      selection.positionM !== undefined ? `x = ${String(selection.positionM)} m (${String(selection.side ?? 'right')})` : undefined,
      selection.end, selection.component, selection.unit,
      selection.modeNumber !== undefined ? `${input.locale === 'zh' ? '模态' : 'Mode'} ${String(selection.modeNumber)}` : undefined,
      selection.timeIndex !== undefined ? `${input.locale === 'zh' ? '时间索引' : 'Time index'} ${String(selection.timeIndex)}` : undefined,
    ].filter(value => value !== undefined).map(String);
    markdown += `\n${input.locale === 'zh' ? '所选输出' : 'Selected output'}: ${tags.join(' · ')}.\n`;
    if (selection.timeIndex !== undefined || selection.modeNumber !== undefined) markdown += input.locale === 'zh'
      ? '\n概况表描述该工况的完整运行；指定数值表中的模态或时间索引限定所选输出。归一化振型为无量纲显示量，不是实际位移。\n'
      : '\nThe summary describes the complete result; mode or time indices in the requested-quantity table identify the selected output. Normalized mode shapes are dimensionless display quantities, not physical displacements.\n';
  }
  if (isRecord(input.codeCheck) && input.codeCheck.completionStatus === 'incomplete') markdown += input.locale === 'zh'
    ? '\n规范校核尚未完成；资料不足或尚不支持的项目不构成通过结论。\n'
    : '\nCode checking is incomplete; missing inputs or unsupported checks do not establish compliance.\n';
  if (isRecord(input.codeCheck) && input.codeCheck.provider === 'native') {
    markdown += input.locale === 'zh'
      ? '\n原生设计使用独立的软件设计组合；结论范围仅含已读回的官方检查项目。\n'
      : '\nNative design uses its own software design combinations; conclusions cover only the official checks read back.\n';
    if (input.codeCheck.designMode === 'required-reinforcement') markdown += input.locale === 'zh'
      ? '\n所需配筋结果不构成已有配筋的验算结论。\n'
      : '\nRequired reinforcement results do not establish compliance of installed reinforcement.\n';
    const cell = (value: unknown) => (value === undefined || value === null ? '—'
      : typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    const checks = Array.isArray(input.codeCheck.details) ? input.codeCheck.details.filter(isRecord) : [];
    if (checks.length) {
      markdown += input.locale === 'zh'
        ? '\n原生检查明细（站点为软件序号）：\n\n| 构件 | 原生站点 | 检查项 | 需求 | 限值 | 单位 | 状态 | 原生组合 | 官方来源 |\n'
        : '\nNative checks (stations are software indices):\n\n| Member | Native station | Check | Demand | Limit | Unit | Status | Native combination | Official source |\n';
      markdown += '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
      markdown += checks.map(row => `| ${[row.elementId, row.nativeStationIndex, row.check,
        row.demand, row.capacity, row.unit, row.status, row.nativeCombination, row.source].map(cell).join(' | ')} |`).join('\n') + '\n';
    }
    const records = Array.isArray(input.codeCheck.records) ? input.codeCheck.records.filter(isRecord) : [];
    if (records.length) {
      markdown += input.locale === 'zh'
        ? '\n原生配筋输出（站点为软件序号，面积不表示已有配筋）：\n\n| 构件 | 原生站点 | 分量 | 所需面积 | SDK计算面积 | 单位 | 原生组合 | 官方来源 |\n'
        : '\nNative reinforcement output (stations are software indices; areas are not installed reinforcement):\n\n| Member | Native station | Component | Required area | SDK calculated area | Unit | Native combination | Official source |\n';
      markdown += '| --- | --- | --- | --- | --- | --- | --- | --- |\n';
      markdown += records.map(row => `| ${[row.elementId, row.nativeStationIndex, row.component,
        row.requiredArea, row.calculatedArea, row.unit, row.nativeCombination, row.source].map(cell).join(' | ')} |`).join('\n') + '\n';
    }
  }
  return { summary, json, markdown };
}

export function createEngineeringReport(input: EngineeringReportInput) {
  return finishEngineeringReport(prepareEngineeringReport(input));
}

/** Optional vendor attachment; the structured report remains authoritative. */
export async function attachNativeReport(report: ReturnType<typeof createEngineeringReport>, input: EngineeringReportInput) {
  const run = isRecord(input.analysis) ? input.analysis : {};
  if (run.success !== true || !run.runId || resultEngine(run) !== 'pkpm') return;
  const data = isRecord(run.data) ? run.data : {};
  const context = isRecord(data.nativeDesignContext) ? data.nativeDesignContext : {};
  const summary = isRecord(data.summary) ? data.summary : {};
  const project = summary.jws_path;
  if (typeof project !== 'string' || typeof context.nativeProject !== 'string'
    || path.resolve(project) !== path.resolve(context.nativeProject)) return;
  prepareEngineeringReport(input);
  try {
    const digest = createHash('sha256').update(await readFile(project)).digest('hex');
    if (digest !== context.nativeProjectSha256) throw new Error('NATIVE_PROJECT_CHANGED');
    const check = isRecord(input.codeCheck) ? input.codeCheck : {};
    const includeDesign = context.eligibleForConclusion === true && check.provider === 'native'
      && check.completionStatus === 'complete';
    const calcbook = await runPkpmCalcbook(project, undefined, { includeDesign, designContext: context });
    report.json.nativeAttachments = [{ kind: 'native-results-reformatted', engine: 'pkpm',
      label: { zh: 'PKPM 原生结果整理版', en: 'PKPM native results, reformatted by StructureClaw' },
      runId: run.runId, modelHash: isRecord(run.meta) ? run.meta.modelHash : undefined,
      sourceProject: project, sourceSha256: digest, includesDesign: includeDesign,
      markdown: calcbook.markdown, artifacts: calcbook.summary, warnings: calcbook.warnings ?? [] }];
  } catch (error) {
    report.json.attachmentIssues = [{ code: 'NATIVE_REPORT_ATTACHMENT_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error) }];
  }
}
