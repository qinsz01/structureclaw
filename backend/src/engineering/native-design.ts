import { isRecord, modelHash, contentHash, type ModelRecord } from './model-state.js';
import { resultEngine } from './result-data.js';
import { executionStatus } from './analysis-runs.js';

export type CodeCheckProvider = 'auto' | 'native' | 'builtin';
export function resolveCheckProvider(provider: CodeCheckProvider | undefined, analysis: ModelRecord): 'native' | 'builtin' {
  const commercial = ['pkpm', 'yjk'].includes(resultEngine(analysis));
  if (provider === 'native' && !commercial) throw new Error('NATIVE_DESIGN_ENGINE_REQUIRED / 原生设计需要商业引擎');
  return provider === 'builtin' ? 'builtin' : commercial ? 'native' : 'builtin';
}

/** Native combinations are a separate design scope, never the selected analysis case. */
export function nativeDesignRecord(model: ModelRecord, run: ModelRecord, code: string): ModelRecord {
  const meta = isRecord(run.meta) ? run.meta : {};
  if (!run.runId || meta.modelHash !== modelHash(model)) throw new Error('NATIVE_DESIGN_RUN_MISMATCH');
  const data = isRecord(run.data) ? run.data : {};
  const context = isRecord(data.nativeDesignContext) ? data.nativeDesignContext : {};
  const native = isRecord(data.nativeDesignResults) ? data.nativeDesignResults : {};
  const request = isRecord(context.request) ? context.request : {};
  const interpreted = Array.isArray(native.checks) ? native.checks : [];
  const rows = interpreted.filter((row): row is ModelRecord => isRecord(row)
    && ['pass', 'fail', 'not_applicable'].includes(String(row.status))
    && isRecord(row.source) && Object.keys(row.source).length > 0 && row.nativeCombination !== undefined);
  const rawRecords = Array.isArray(native.records) ? native.records : [];
  const reinforcement = rawRecords.filter((row): row is ModelRecord => isRecord(row)
    && typeof row.elementId === 'string' && typeof row.component === 'string' && row.unit === 'mm2'
    && typeof row.requiredArea === 'number' && Number.isFinite(row.requiredArea) && row.requiredArea >= 0
    && (row.calculatedArea === undefined || typeof row.calculatedArea === 'number' && Number.isFinite(row.calculatedArea) && row.calculatedArea >= 0)
    && isRecord(row.source) && Object.keys(row.source).length > 0 && row.nativeCombination !== undefined);
  const requiredReinforcement = request.mode === 'required-reinforcement';
  const eligible = run.success === true && context.eligibleForConclusion === true && request.requested === true
    && request.code === code && rows.length === interpreted.length
    && (requiredReinforcement ? reinforcement.length > 0 && reinforcement.length === rawRecords.length : rows.length > 0);
  const checks = eligible ? rows : [];
  const failure = run.success === false && isRecord(run.results) && isRecord(run.results[String(run.selectedResultKey)])
    ? run.results[String(run.selectedResultKey)] as ModelRecord : run;
  const status = executionStatus(failure);
  const missingInputs = Array.isArray(context.missingInputs) ? context.missingInputs : status === 'insufficient_data'
    ? [{reason:failure.message,errorCode:failure.error_code}] : [];
  const summary = { total: checks.length, passed: checks.filter(row => row.status === 'pass').length,
    failed: checks.filter(row => row.status === 'fail').length,
    notApplicable: checks.filter(row => row.status === 'not_applicable').length,
    inputRequired: missingInputs.length, unsupported: status === 'unsupported' || (!eligible && !missingInputs.length && status === 'completed') ? 1 : 0, warnings: 0 };
  const record = { provider: 'native', designCode: code, completionStatus: eligible ? 'complete' : 'incomplete',
    complianceStatus: eligible && requiredReinforcement ? 'not_evaluated'
      : summary.failed ? 'fail' : eligible ? summary.passed ? 'pass' : 'not_applicable' : 'incomplete',
    summary, details: checks, missingInputs, nativeDesignContext: context, nativeDesignResults: native,
    records: eligible ? reinforcement : [], designMode: request.mode,
    complianceScope: native.complianceScope ?? 'reported-native-checks-only',
    ...(requiredReinforcement ? { reinforcementScope: 'required-not-installed' } : {}),
    executionStatus: status, ...(failure.success === false ? {errorCode:failure.error_code,message:failure.message} : {}),
    designStatus: context.status ?? (failure.success === false ? status : 'native-design-not-requested'), combinationScope: context.combinationScope ?? 'native-design-combinations',
    boundToSelectedAnalysisResult: false,
    meta: { runId: run.runId, modelHash: meta.modelHash, modelRevision: meta.modelRevision,
      settingsHash: meta.settingsHash, designInputsHash: context.designInputsHash, provider: 'native', engine: resultEngine(run) } };
  return { ...record, designRecordId: contentHash(record) };
}
