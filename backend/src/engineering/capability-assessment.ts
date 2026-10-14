import { assertInputEvidenceMatchesModel, unresolvedInputEvidence } from './input-evidence.js';
import { currentAnalysisError, isRecord, type ModelState } from './model-state.js';

/** A read-only projection, never a replacement for model/solver preflight. */
export function assessCurrentEngineeringInput(state?: ModelState, conversationId?: string) {
  if (!conversationId) return { status: 'not_assessed', issues: [], conversationId: null };
  if (!state) return { status: 'unavailable', issues: [], conversationId };
  const issues: Array<{ kind: string; field: string; reason: string }> = [];
  const model = state.model;
  const evidence = [...(state.inputEvidence ?? []), ...(isRecord(model?.metadata) && Array.isArray(model.metadata.inputEvidence)
    ? model.metadata.inputEvidence : [])];
  for (const item of unresolvedInputEvidence(evidence)) issues.push({ kind: 'input', ...item });
  if (!model) issues.push({ kind: 'model', field: 'model', reason: 'MODEL_REQUIRED' });
  else {
    if (state.modelPending) issues.push({ kind: 'model', field: 'model', reason: 'MODEL_REBUILD_REQUIRED' });
    if (!issues.some(item => item.kind === 'input')) {
      try { assertInputEvidenceMatchesModel(model, state.inputEvidence); assertInputEvidenceMatchesModel(model); }
      catch (error) { issues.push({ kind: 'input', field: 'model', reason: error instanceof Error ? error.message : 'INPUT_EVIDENCE_NOT_APPLIED' }); }
    }
  }
  const analysisError = currentAnalysisError(state);
  if (analysisError) issues.push({ kind: 'analysis', field: 'analysis', reason: analysisError });
  const run = state.analysisResult;
  const check = state.codeCheckResult;
  const checkCurrent = !analysisError && check && isRecord(check.meta) && check.meta.runId === run?.runId;
  if (checkCurrent && Array.isArray(check.missingInputs)) for (const item of check.missingInputs.filter(isRecord)) {
    issues.push({ kind: 'code-check', field: String(item.field ?? 'native-design'), reason: String(item.reason ?? 'input_required') });
  }
  if (checkCurrent && Array.isArray(check.details)) for (const detail of check.details.filter(isRecord)) {
    if (['input_required', 'unsupported'].includes(String(detail.status))) {
      issues.push({ kind: 'code-check', field: String(detail.id ?? detail.elementId ?? detail.check ?? 'native-design'), reason: String(detail.status) });
    }
    if (!Array.isArray(detail.checks)) continue;
    for (const group of detail.checks.filter(isRecord)) {
      if (!Array.isArray(group.items)) continue;
      for (const item of group.items.filter(isRecord)) if (['input_required', 'unsupported'].includes(String(item.status))) {
        issues.push({ kind: 'code-check', field: `${String(detail.resultKey ?? '')}/${String(detail.elementId ?? '')}/${String(item.clause ?? item.item)}`,
          reason: String(item.status) });
      }
    }
  }
  if (checkCurrent && check.completionStatus === 'incomplete' && !issues.some(item => item.kind === 'code-check')) {
    issues.push({ kind: 'code-check', field: 'code-check', reason: 'incomplete' });
  }
  if (!analysisError && run?.capabilityStatus && run.capabilityStatus !== 'complete') {
    issues.push({ kind: 'result', field: 'results', reason: String(run.capabilityStatus) });
  }
  const unique = [...new Map(issues.map(item => [JSON.stringify(item), item])).values()];
  const summary = checkCurrent && isRecord(check.summary) ? check.summary : undefined;
  return { conversationId, status: unique.length ? 'needs_attention' : 'current_result',
    modelRevision: state.modelRevision ?? null, runId: run?.runId ?? null,
    analysisStatus: analysisError ?? 'current',
    codeCheckStatus: checkCurrent ? String(check.completionStatus ?? check.status ?? 'unknown') : 'not_current_or_not_run',
    codeCheckCounts: summary ? Object.fromEntries(['passed', 'failed', 'inputRequired', 'unsupported'].map(key =>
      [key, typeof summary[key] === 'number' ? summary[key] : null])) : null,
    issues: unique.slice(0, 100), totalIssues: unique.length, issuesTruncated: unique.length > 100,
    scope: 'recorded-input-and-result-state; solver preflight and engineering checks still apply' };
}
