import { isRecord, type ModelRecord } from './model-state.js';

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
  return {
    ...selected, summary, checkResults: checks,
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
