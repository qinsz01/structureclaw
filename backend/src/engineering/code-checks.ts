import { isRecord, type ModelRecord } from './model-state.js';
import { modelEditGuidance, sectionPropertyUnits } from './model-edit-contract.js';

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

/** Keep both missing inputs and computed evidence in the agent's tool response. */
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
    nextAction = unresolvedResults.length ? 'inspect_analysis' : unsupported && !missingFields.length ? 'inspect_capability' : 'ask_user_clarification';
  }
  return { completionStatus: check.completionStatus, complianceStatus: check.complianceStatus, summary: check.summary,
    checkedItems: { runId: isRecord(check.meta) ? check.meta.runId : undefined,
      totalCount: checkedItems.length, truncated: checkedItems.length > 100, items: checkedItems.slice(0, 100) },
    ...(check.checkScope ? { checkScope: check.checkScope } : {}),
    requestedChecksPassed: check.completionStatus === 'complete' && check.complianceStatus === 'pass',
    missingInputs: missingFields, writeTargets: [...writeTargets.values()], missingInputCount: writeTargets.size + missingFields.filter(row => !row.writable).length,
    availableResultKeys: isRecord(analysis?.results) ? Object.keys(analysis.results) : [], editGuidance: modelEditGuidance,
    guidance: 'Write already supplied inputs to the listed owners; ask only for genuinely missing conditions. Counts of input-required checks are not counts of questions. Explain checks using checkedItems: preserve each formula, demand, capacity, unit, utilization and selection. Never combine coefficients across different checks or invent missing calculations. If truncated, use the saved report for remaining items. / 已确认输入按目标路径写入，仅询问真正缺失的条件；待输入校核项数不等于问题数。校核解释须引用checkedItems中各自的公式、需求、承载力、单位、利用率及工况，不得混用不同校核的系数或编造缺失计算；截断的其余项目查阅保存报告。',
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
  const fields = (feedback.missingInputs as ModelRecord[]);
  const list = fields.slice(0, 12).map(field => `- ${String(field.elementId)}: ${String(field.label)} (${String(field.unit)})`).join('\n');
  const tail = fields.length > 12 ? locale === 'zh' ? '\n完整缺项见校核结果。' : '\nSee the check result for all missing inputs.' : '';
  return locale === 'zh'
    ? `规范校核尚未完成，不能给出设计合格结论。\n\n${formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale)}。\n\n${list ? `需要补充或核实：\n${list}${tail}\n\n` : ''}请补充上述资料；计算结果缺失项需检查分析工况，不能用手填数值替代。确认后在当前模型上继续校核。`
    : `Code checking is incomplete; design compliance has not been established.\n\n${formatCheckSummary(isRecord(check.summary) ? check.summary : undefined, locale)}.\n\n${list ? `Provide or verify:\n${list}${tail}\n\n` : ''}Supply the missing inputs. Missing computed results require inspection of the analysis case, not manually invented values. Then continue checking the current model.`;
}
