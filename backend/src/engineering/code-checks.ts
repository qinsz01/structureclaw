import { isRecord, type ModelRecord } from './model-state.js';
import { modelEditGuidance, sectionPropertyUnits } from './model-edit-contract.js';
import { codeCheckLabelEn } from '../agent-skills/code-check/labels.js';

/** A declared service case must exist in this run before other cases may be excluded. */
export function validateServiceabilitySelection(model: ModelRecord, analysis: ModelRecord): void {
  const available = isRecord(analysis.results) ? Object.keys(analysis.results)
    : [analysis.selectedResultKey ?? (isRecord(analysis.selection) ? analysis.selection.key : undefined)].filter((key): key is string => typeof key === 'string');
  for (const element of Array.isArray(model.elements) ? model.elements.filter(isRecord) : []) {
    const keys = isRecord(element.design) ? element.design.serviceability_result_keys : undefined;
    if (!Array.isArray(keys)) continue;
    const unknown = keys.filter(key => !available.includes(key));
    if (unknown.length) throw new Error(`SERVICEABILITY_RESULT_UNAVAILABLE: elements.${element.id}.design.serviceability_result_keys=${JSON.stringify(unknown)}; available=${JSON.stringify(available)} / 指定使用工况不在当前运行中，请将所需工况纳入分析`);
  }
}

/** Check actual case results independently; never combine component-wise force envelopes. */
export async function checkRunResults(analysis: ModelRecord, execute: (result: ModelRecord) => Promise<ModelRecord>): Promise<ModelRecord> {
  if (!isRecord(analysis.results)) return execute(analysis);
  const checks: ModelRecord = {};
  for (const [key, result] of Object.entries(analysis.results)) {
    if (!isRecord(result) || result.success === false) throw new Error(`CHECK_RESULT_UNAVAILABLE: ${key}`);
    const checked = await execute(result);
    checks[key] = { ...checked, resultKey: key, source: result.meta,
      ...(result.capabilityStatus === 'partial' ? { completionStatus: 'incomplete', complianceStatus: checked.complianceStatus === 'fail' ? 'fail' : 'incomplete', analysisLimitation: 'partial analysis' } : {}) };
  }
  const entries = Object.values(checks).filter(isRecord);
  const selected = isRecord(checks[String(analysis.selectedResultKey)]) ? checks[String(analysis.selectedResultKey)] as ModelRecord : entries[0];
  if (!selected) throw new Error('CHECK_RESULTS_EMPTY');
  const summary: ModelRecord = {};
  for (const key of ['total', 'passed', 'failed', 'warnings', 'notApplicable', 'inputRequired', 'unsupported']) {
    summary[key] = entries.reduce((sum, item) => sum + Number(isRecord(item.summary) ? item.summary[key] ?? 0 : 0), 0);
  }
  const values = entries.flatMap((item) => isRecord(item.summary) && typeof item.summary.maxUtilization === 'number' ? [item.summary.maxUtilization] : []);
  summary.maxUtilization = values.length ? Math.max(...values) : null;
  // Keep the governing element and check of the case that holds the maximum utilization.
  const governing = entries.find((item) => isRecord(item.summary) && item.summary.maxUtilization === summary.maxUtilization)?.summary as ModelRecord | undefined;
  for (const key of ['controllingElement', 'controllingCheck'] as const) {
    if (governing?.[key] !== undefined && governing[key] !== null) summary[key] = governing[key];
  }
  const incomplete = entries.some((item) => item.completionStatus !== 'complete');
  const scopes = entries.filter(item => isRecord(item.checkScope)).map(item => item.checkScope as ModelRecord);
  return {
    ...selected, summary, checkResults: checks,
    ...(scopes.length ? { checkScope: { ...scopes[0], limited: scopes.some(scope => scope.limited === true) } } : {}),
    details: entries.flatMap((item) => Array.isArray(item.details) ? item.details.map((detail) => ({ ...(isRecord(detail) ? detail : {}), resultKey: item.resultKey })) : []),
    completionStatus: incomplete ? 'incomplete' : 'complete',
    complianceStatus: entries.some((item) => item.complianceStatus === 'fail') ? 'fail' : incomplete ? 'incomplete' : entries.every((item) => item.complianceStatus === 'not_applicable') ? 'not_applicable' : 'pass',
  };
}

export function formatCheckSummary(summary: ModelRecord | undefined, locale: 'zh' | 'en'): string {
  if (!summary) return locale === 'zh' ? '未执行规范校核' : 'No code checks were executed';
  const value = (key: string) => String(summary[key] ?? 0);
  const unavailable = Number(summary.inputRequired ?? 0) + Number(summary.unsupported ?? 0);
  const scope = locale === 'zh'
    ? `，资料不足 ${value('inputRequired')}，不支持 ${value('unsupported')}`
    : `, input required ${value('inputRequired')}, unsupported ${value('unsupported')}`;
  const notApplicable = summary.notApplicable ?? summary.not_applicable;
  const suffix = notApplicable === undefined ? '' : locale === 'zh' ? `，不适用 ${String(notApplicable)}` : `, not applicable ${String(notApplicable)}`;
  const base = locale === 'zh'
    ? `校核通过 ${value('passed')} / ${value('total')}，失败 ${value('failed')}，警告 ${value('warnings')}`
    : `Code checks passed ${value('passed')} / ${value('total')}, failed ${value('failed')}, warnings ${value('warnings')}`;
  return base + suffix + (unavailable || summary.inputRequired !== undefined || summary.unsupported !== undefined ? scope : '');
}

const DESIGN_VALUE_LABELS: Record<string, { zh: string; en: string }> = {
  'material.design.f': { zh: '抗拉、抗压和抗弯强度设计值 f', en: 'design strength f' },
  'material.design.fv': { zh: '抗剪强度设计值 fv', en: 'shear design strength fv' },
  'material.fy': { zh: '屈服强度 fy', en: 'yield strength fy' },
  'material.design.fc': { zh: '混凝土轴心抗压强度设计值 fc', en: 'concrete design strength fc' },
  'material.design.ft': { zh: '混凝土轴心抗拉强度设计值 ft', en: 'concrete tensile design strength ft' },
  'material.design.fy': { zh: '钢筋抗拉强度设计值 fy', en: 'rebar design strength fy' },
  'material.design.fyv': { zh: '箍筋抗拉强度设计值 fyv', en: 'stirrup design strength fyv' },
  'section.b': { zh: '翼缘外伸宽度 b', en: 'flange outstand b' },
  'section.t': { zh: '翼缘厚度 t', en: 'flange thickness t' },
  'section.h0': { zh: '腹板计算高度 h0', en: 'web depth h0' },
  'section.tw': { zh: '腹板厚度 tw', en: 'web thickness tw' },
  'section.Wnx': { zh: '强轴截面模量 Wnx', en: 'strong-axis section modulus Wnx' },
  'section.Wz': { zh: '弱轴截面模量 Wz', en: 'weak-axis section modulus Wz' },
  'section.S': { zh: '面积矩 S', en: 'first moment of area S' },
  'section.imin': { zh: '最小回转半径 imin', en: 'minimum radius of gyration imin' },
  epsilonK: { zh: '钢号修正系数 εk', en: 'steel grade factor εk' },
  'member.design.btLimit': { zh: '翼缘宽厚比限值', en: 'flange width-thickness limit' },
  'member.design.webLimit': { zh: '腹板高厚比限值', en: 'web depth-thickness limit' },
  'member.design.beta1': { zh: '折算应力强度增大系数 β1', en: 'equivalent-stress factor β1' },
  'member.design.lambdaLimit': { zh: '容许长细比 [λ]', en: 'slenderness limit [λ]' },
};

/** Design values each check used, with their recorded sources, grouped over the elements sharing them. */
export function checkDesignValues(check: ModelRecord): ModelRecord[] {
  const rows = new Map<string, ModelRecord>();
  for (const detail of Array.isArray(check.details) ? check.details.filter(isRecord) : []) {
    for (const value of Array.isArray(detail.designValues) ? detail.designValues.filter(isRecord) : []) {
      const key = JSON.stringify([value.field, value.value, value.unit, value.source]);
      const saved = rows.get(key);
      if (saved) saved.elementIds = [...new Set([...(saved.elementIds as unknown[]), detail.elementId])];
      else rows.set(key, { ...value, elementIds: [detail.elementId] });
    }
  }
  return [...rows.values()];
}

/** One line per value: label = value unit (source). */
export function designValueLines(rows: ModelRecord[], locale: 'zh' | 'en'): string[] {
  return rows.map(row => {
    const label = DESIGN_VALUE_LABELS[String(row.field)];
    const name = label ? label[locale] : String(row.field);
    const unit = row.unit && row.unit !== '1' ? ` ${String(row.unit)}` : '';
    const value = typeof row.value === 'number' && Number.isFinite(row.value) ? String(Number(row.value.toPrecision(6))) : String(row.value);
    return locale === 'zh' ? `- ${name} = ${value}${unit}（${String(row.source)}）`
      : `- ${name} = ${value}${unit} (${String(row.source)})`;
  });
}

/**
 * Keep both missing inputs and computed evidence in the agent's tool response. Missing inputs are
 * reported, never turned into a clarification interrupt, with or without the clarification tool.
 */
export function codeCheckFeedback(check: ModelRecord, model?: ModelRecord, analysis?: ModelRecord): ModelRecord {
  const missingInputs: ModelRecord[] = [];
  const checkedItems: ModelRecord[] = [];
  for (const detail of Array.isArray(check.details) ? check.details.filter(isRecord) : []) {
    for (const group of Array.isArray(detail.checks) ? detail.checks.filter(isRecord) : []) {
      for (const item of Array.isArray(group.items) ? group.items.filter(isRecord) : []) {
        checkedItems.push({ elementId: detail.elementId, resultKey: detail.resultKey ?? check.resultKey,
          check: item.item, clause: item.clause, status: item.status, formula: item.formula,
          utilization: item.utilization, ...(isRecord(item.inputs) ? { inputs: item.inputs } : {}),
          ...(isRecord(item.forceState) ? { forceState: item.forceState } : {}),
          ...(item.message ? { message: item.message } : {}) });
        if (item.status !== 'input_required') continue;
        missingInputs.push({ elementId: detail.elementId, resultKey: detail.resultKey, check: item.item, clause: item.clause,
          fields: Array.isArray(item.missingInputs) ? item.missingInputs : [], message: item.message });
      }
    }
  }
  const fields = new Map<string, ModelRecord>();
  for (const row of missingInputs) for (const field of (row.fields as unknown[]).filter(isRecord)) {
    const key = JSON.stringify([row.elementId, field.field]);
    const saved = fields.get(key);
    if (saved) {
      saved.checks = [...new Set([...(saved.checks as unknown[]), row.check])];
      saved.resultKeys = [...new Set([...(saved.resultKeys as unknown[]), row.resultKey])];
    } else fields.set(key, { ...field, elementId: row.elementId, checks: [row.check], resultKeys: [row.resultKey] });
  }
  const writeTargets = new Map<string, ModelRecord>();
  const missingFields = [...fields.values()].map((row): ModelRecord => {
    const element = (Array.isArray(model?.elements) ? model.elements.filter(isRecord) : []).find(item => item.id === row.elementId);
    const field = String(row.field);
    const owner = field.startsWith('material.design.') ? ['materials', element?.material, field.replace('material.', '')]
      : field.startsWith('member.design.') ? ['elements', element?.id, field.replace('member.', '')]
      : field.startsWith('section.') ? ['sections', element?.section, `properties.${field.slice(8) === 'I' ? 'Iy' : field.slice(8)}`] : undefined;
    if (!owner || !owner[1]) return { ...row, action: 'inspect_analysis', writable: false };
    const modelUnit = owner[0] === 'sections' ? sectionPropertyUnits[String(owner[2]).slice(11)] : row.unit;
    const scale = row.unit === 'mm3' && modelUnit === 'm3' ? 1e-9 : row.unit === 'mm4' && modelUnit === 'm4' ? 1e-12
      : row.unit === 'mm2' && modelUnit === 'm2' ? 1e-6 : row.unit === 'mm' && modelUnit === 'm' ? .001 : 1;
    const writeTarget = { collection: owner[0], id: owner[1], path: owner[2], modelUnit, inputUnit: row.unit, inputToModelScale: scale };
    const key = JSON.stringify(owner);
    const grouped = writeTargets.get(key);
    if (grouped) grouped.elementIds = [...new Set([...(grouped.elementIds as unknown[]), row.elementId])];
    else writeTargets.set(key, { ...writeTarget, label: row.label, elementIds: [row.elementId] });
    return { ...row, writable: true, writeTarget };
  });
  const limited = isRecord(check.checkScope) && check.checkScope.limited === true;
  const unresolvedResults = missingFields.filter(row => row.source === 'result' && !(row.field === 'response.deflection' && missingFields.some(field => field.elementId === row.elementId && field.field === 'member.design.serviceability_result_keys')));
  let nextAction = 'generate_report';
  if (check.completionStatus !== 'complete') {
    const unsupported = Number(isRecord(check.summary) ? check.summary.unsupported ?? 0 : 0) > 0;
    // Missing design inputs never interrupt: the check is delivered with performed items and the
    // not-performed list; the user may supply inputs in a later turn.
    nextAction = unresolvedResults.length ? 'inspect_analysis' : unsupported && !missingFields.length ? 'inspect_capability' : 'report_missing_inputs';
  }
  const designValues = checkDesignValues(check);
  return { completionStatus: check.completionStatus, complianceStatus: check.complianceStatus, summary: check.summary,
    checkedItems: { runId: isRecord(check.meta) ? check.meta.runId : undefined,
      totalCount: checkedItems.length, truncated: checkedItems.length > 100, items: checkedItems.slice(0, 100) },
    ...(designValues.length ? { designValues } : {}),
    ...(check.checkScope ? { checkScope: check.checkScope } : {}),
    requestedChecksPassed: check.completionStatus === 'complete' && check.complianceStatus === 'pass',
    missingInputs: missingFields, writeTargets: [...writeTargets.values()], missingInputCount: writeTargets.size + missingFields.filter(row => !row.writable).length,
    availableResultKeys: isRecord(analysis?.results) ? Object.keys(analysis.results) : [], editGuidance: modelEditGuidance,
    guidance: 'designValues lists code- and geometry-determined values (design strengths from grade and thickness, section properties, clause factors) with their sources; cite them with their sources in the reply and never ask the user for them. Do not ask clarification questions for missing design inputs and do not loop: report the performed checks and list the checks not performed with their missing inputs in the final reply; the user may supply them in a later turn. Write inputs the user already supplied to the listed owners. Explain checks using checkedItems: preserve each formula, demand, capacity, unit, utilization and selection. Never combine coefficients across different checks or invent missing calculations. If truncated, use the saved report for remaining items. / 不要为缺失设计输入发起追问或循环：在最终回复中报告已完成校核，并列出未执行项及所缺输入，用户可在后续轮次补充；用户已给出的输入按目标路径写入。校核解释须引用checkedItems中各自的公式、需求、承载力、单位、利用率及工况，不得混用不同校核的系数或编造缺失计算；截断的其余项目查阅保存报告。',
    inputRequiredChecks: missingInputs.map(({ fields: _fields, ...row }) => row),
    nextAction,
    conclusionEligible: !limited && check.completionStatus === 'complete' && check.complianceStatus === 'pass' };
}

/** Lossless grouping for the model context only; saved checks and public tool outputs stay complete. */
export function compactCodeCheckFeedback(feedback: ModelRecord): ModelRecord {
  if (!isRecord(feedback.checkedItems) || !Array.isArray(feedback.checkedItems.items)
    || !Array.isArray(feedback.missingInputs)) return feedback;
  const items = feedback.checkedItems.items;
  if (!items.every(isRecord) || !feedback.missingInputs.every(isRecord)) return feedback;
  const group = (rows: ModelRecord[], varying: string[]) => {
    const groups = new Map<string, ModelRecord>();
    for (const row of rows) {
      const shared = Object.fromEntries(Object.entries(row).filter(([key]) => !varying.includes(key)));
      const binding = Object.fromEntries(Object.entries(row).filter(([key]) => varying.includes(key)));
      const key = JSON.stringify(shared);
      const existing = groups.get(key);
      if (existing) (existing.appliesTo as ModelRecord[]).push(binding);
      else groups.set(key, { ...shared, appliesTo: [binding] });
    }
    return [...groups.values()];
  };
  // These two indexes repeat data already present in checkedItems/missingInputs.
  // Retain any unfamiliar or unmatched row instead of assuming it is redundant.
  const required = Array.isArray(feedback.inputRequiredChecks) ? feedback.inputRequiredChecks.filter(row => !isRecord(row)
    || !items.some(item => Object.entries(row).every(([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value)))) : feedback.inputRequiredChecks;
  const targets = Array.isArray(feedback.writeTargets) ? feedback.writeTargets.filter(row => !isRecord(row)
    || !Array.isArray(row.elementIds) || !row.elementIds.every(id => feedback.missingInputs instanceof Array
      && feedback.missingInputs.some(field => isRecord(field) && field.elementId === id && isRecord(field.writeTarget)
        && Object.entries(row).every(([key, value]) => key === 'elementIds'
          || JSON.stringify(key === 'label' ? field.label : (field.writeTarget as ModelRecord)[key]) === JSON.stringify(value))))) : feedback.writeTargets;
  return { ...feedback,
    checkedItems: { ...feedback.checkedItems, items: group(items, ['elementId', 'resultKey', 'forceState']) },
    missingInputs: group(feedback.missingInputs, ['elementId', 'checks', 'resultKeys']),
    ...(Array.isArray(required) && required.length === 0 ? { inputRequiredChecks: undefined } : { inputRequiredChecks: required }),
    ...(Array.isArray(targets) && targets.length === 0 ? { writeTargets: undefined } : { writeTargets: targets }),
    contextFormat: 'Grouped rows: each appliesTo entry inherits all fields of its parent. Full original tool output and checks remain saved. / 分组行的每个 appliesTo 项继承父行全部字段；原始工具输出与校核明细完整保留。',
  };
}

/** An incomplete engineering check must not be promoted to compliance by final prose. */
export function codeCheckDeliveryNotice(check: ModelRecord, locale: 'zh' | 'en'): string {
  if (check.completionStatus === 'complete' && check.complianceStatus === 'pass' && isRecord(check.checkScope) && check.checkScope.limited === true) {
    const elements = isRecord(check.checkScope.elements) ? check.checkScope.elements : {};
    const selected = [...new Set(Object.values(elements).filter(isRecord).flatMap(scope => Array.isArray(scope.requestedChecks) ? scope.requestedChecks : []))].join('、');
    return locale === 'zh'
      ? `已完成并通过用户指定的专项校核：${selected}。\n\n${formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale)}。其余项目未校核，不能据此给出完整设计合格结论。`
      : `The requested checks are complete and passed: ${selected}.\n\n${formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale)}. Other checks were not requested; this does not establish complete design compliance.`;
  }
  if (check.complianceStatus === 'fail') return locale === 'zh'
    ? `规范校核存在未通过项，不能给出设计合格结论。\n\n${formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale)}。请查看已保存校核明细中的控制构件及需求、承载力，再决定修改方案。`
    : `Code checking found failed items; design compliance has not been established.\n\n${formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale)}. Inspect the saved governing member, demand and capacity before deciding how to revise the model.`;
  const feedback = codeCheckFeedback(check);
  const summaryText = formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale);
  const { performed, notPerformed } = checkDeliveryLists(feedback, locale);
  const designValues = designValueLines(checkDesignValues(check), locale);
  const valuesText = designValues.length
    ? (locale === 'zh' ? `采用的规范及几何确定值：\n${designValues.join('\n')}\n\n` : `Code- and geometry-determined values used:\n${designValues.join('\n')}\n\n`)
    : '';
  const performedText = performed.length
    ? (locale === 'zh' ? `已完成的校核：\n${performed.join('\n')}\n\n` : `Checks performed:\n${performed.join('\n')}\n\n`)
    : (locale === 'zh' ? '尚无可完成的校核项。\n\n' : 'No check could be completed yet.\n\n');
  const notPerformedText = notPerformed.length
    ? (locale === 'zh' ? `未执行的校核及所缺输入 / Checks not performed and missing inputs：\n${notPerformed.join('\n')}\n\n`
      : `Checks not performed and missing inputs / 未执行的校核及所缺输入:\n${notPerformed.join('\n')}\n\n`)
    : '';
  return locale === 'zh'
    ? `规范校核未全部完成，不能给出设计合格结论。\n\n${summaryText}。\n\n${performedText}${valuesText}${notPerformedText}如需完成其余校核，请在后续消息中提供上述输入（不会使用默认值）；计算结果缺失项需检查分析工况，不能用手填数值替代。`
    : `Code checking is not complete; design compliance has not been established.\n\n${summaryText}.\n\n${performedText}${valuesText}${notPerformedText}To complete the remaining checks, supply these inputs in a later message (no defaults are assumed). Missing computed results require inspection of the analysis case, not manually invented values.`;
}

const bilingualCheckName = (value: unknown): string => {
  const name = String(value ?? '');
  const en = codeCheckLabelEn(name);
  return en && en !== name ? `${name} / ${en}` : name;
};

/** Performed checks (status and governing utilization) and not-performed checks with their missing inputs. */
function checkDeliveryLists(feedback: ModelRecord, locale: 'zh' | 'en'): { performed: string[]; notPerformed: string[] } {
  const items = isRecord(feedback.checkedItems) && Array.isArray(feedback.checkedItems.items) ? feedback.checkedItems.items.filter(isRecord) : [];
  const performed = new Map<string, { clause: unknown; statuses: Set<string>; utilization: number | undefined }>();
  for (const item of items.filter(row => !['input_required', 'unsupported'].includes(String(row.status)))) {
    const key = String(item.check);
    const saved = performed.get(key) ?? { clause: item.clause, statuses: new Set<string>(), utilization: undefined };
    saved.statuses.add(String(item.status));
    if (typeof item.utilization === 'number' && Number.isFinite(item.utilization)) saved.utilization = Math.max(saved.utilization ?? 0, item.utilization);
    performed.set(key, saved);
  }
  const missing = new Map<string, { clause: unknown; fields: Set<string> }>();
  for (const field of Array.isArray(feedback.missingInputs) ? feedback.missingInputs.filter(isRecord) : []) {
    for (const name of Array.isArray(field.checks) ? field.checks : []) {
      const key = String(name);
      const saved = missing.get(key) ?? { clause: items.find(item => item.check === name)?.clause, fields: new Set<string>() };
      saved.fields.add(`${String(field.label)} (${String(field.unit)})`);
      missing.set(key, saved);
    }
  }
  const clause = (value: unknown) => value ? ` [${String(value)}]` : '';
  const utilizationText = (value: number | undefined) => value === undefined ? '' : locale === 'zh' ? `，最大利用率 ${value.toFixed(3)}` : `, max utilization ${value.toFixed(3)}`;
  return {
    performed: [...performed.entries()].map(([name, row]) => `- ${bilingualCheckName(name)}${clause(row.clause)}: ${[...row.statuses].join('/')}${utilizationText(row.utilization)}`),
    notPerformed: [...missing.entries()].map(([name, row]) => `- ${bilingualCheckName(name)}${clause(row.clause)}: ${[...row.fields].join('; ')}`),
  };
}
