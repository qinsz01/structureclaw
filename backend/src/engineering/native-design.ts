import { isRecord, modelHash, contentHash, type ModelRecord } from './model-state.js';
import { resultEngine } from './result-data.js';

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
  const interpreted = Array.isArray(native.checks) ? native.checks.filter(isRecord) : [];
  const rows = interpreted.filter(row => ['pass', 'fail', 'not_applicable'].includes(String(row.status))
    && typeof row.source === 'object' && row.source !== null && row.nativeCombination !== undefined);
  const eligible = run.success === true && context.eligibleForConclusion === true && request.requested === true
    && request.code === code && rows.length > 0 && rows.length === interpreted.length;
  const checks = eligible ? rows : [];
  const missingInputs = Array.isArray(context.missingInputs) ? context.missingInputs : [];
  const summary = { total: checks.length, passed: checks.filter(row => row.status === 'pass').length,
    failed: checks.filter(row => row.status === 'fail').length,
    notApplicable: checks.filter(row => row.status === 'not_applicable').length,
    inputRequired: missingInputs.length, unsupported: eligible || missingInputs.length ? 0 : 1, warnings: 0 };
  const record = { provider: 'native', designCode: code, completionStatus: eligible ? 'complete' : 'incomplete',
    complianceStatus: summary.failed ? 'fail' : eligible ? summary.passed ? 'pass' : 'not_applicable' : 'incomplete',
    summary, details: checks, missingInputs, nativeDesignContext: context, nativeDesignResults: native,
    designStatus: context.status ?? 'native-design-not-requested', combinationScope: context.combinationScope ?? 'native-design-combinations',
    boundToSelectedAnalysisResult: false,
    meta: { runId: run.runId, modelHash: meta.modelHash, modelRevision: meta.modelRevision,
      settingsHash: meta.settingsHash, designInputsHash: context.designInputsHash, provider: 'native', engine: resultEngine(run) } };
  return { ...record, designRecordId: contentHash(record) };
}
