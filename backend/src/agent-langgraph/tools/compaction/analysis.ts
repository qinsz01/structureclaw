import type { AgentState } from '../../state.js';
import { commitModel, invalidateStaleResults } from '../../../engineering/model-state.js';
import { compactText } from './context.js';
import { stiffnessPlaceholderOf } from '../../../engineering/stiffness-placeholder.js';
import { pickAnalysisDiagnostics, buildSuccessfulAnalysisDetails, compactReactionTotals } from './summary.js';
import { isRecord, optionalRecord } from '../shared.js';
import { sectionAssumptions } from '../../../engineering/section-assumptions.js';

function normalizeAnalysisErrorCode(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return 'ANALYSIS_EXECUTION_FAILED';
}

export function getAnalysisPayload(result: Record<string, unknown>): Record<string, unknown> {
  return isRecord(result.data) ? result.data : result;
}

const FAILED_ANALYSIS_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'unsupported',
  'rejected',
  'cancelled',
  'canceled',
  'timeout',
  'timed_out',
]);

const SUCCESSFUL_ANALYSIS_STATUSES = new Set([
  'success',
  'succeeded',
  'complete',
  'completed',
]);

function isExplicitAnalysisFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.success === false) return true;
  const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : '';
  return FAILED_ANALYSIS_STATUSES.has(status);
}

function isExplicitAnalysisSuccess(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.success === true) return true;
  const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : '';
  return SUCCESSFUL_ANALYSIS_STATUSES.has(status);
}

function hasExplicitAnalysisFailure(
  result: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  const records = result === data ? [result] : [result, data];
  for (const record of records) {
    if (isExplicitAnalysisFailure(record)) return true;
    const caseResults = optionalRecord(record.caseResults);
    if (caseResults && Object.values(caseResults).some(isExplicitAnalysisFailure)) return true;
  }
  return false;
}

function hasExplicitAnalysisSuccess(
  result: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  const records = result === data ? [result] : [result, data];
  for (const record of records) {
    if (isExplicitAnalysisSuccess(record)) return true;
    const caseResults = optionalRecord(record.caseResults);
    if (caseResults && Object.values(caseResults).some(isExplicitAnalysisSuccess)) return true;
  }
  return false;
}

export function buildAnalysisToolSummary(args: {
  result: unknown;
  skillId?: string;
  model?: Record<string, unknown>;
}): Record<string, unknown> {
  const result = isRecord(args.result) ? args.result : {};
  const meta = isRecord(result.meta) ? result.meta : {};
  const data = getAnalysisPayload(result);
  const explicitFailure = hasExplicitAnalysisFailure(result, data);
  const explicitSuccess = hasExplicitAnalysisSuccess(result, data);
  const success = !explicitFailure && explicitSuccess;

  if (!success) {
    const invalidResult = !explicitFailure && !explicitSuccess;
    const errorCode = invalidResult
      ? 'ANALYSIS_RESULT_INVALID'
      : normalizeAnalysisErrorCode(
          result.error_code ?? data.error_code,
          result.errorCode ?? data.errorCode,
        );
    const diagnostics = pickAnalysisDiagnostics(result, meta);
    const results = optionalRecord(result.results) ?? optionalRecord(data.results);
    const failures = Object.entries(results ?? {}).filter(([, value]) => isExplicitAnalysisFailure(value));
    return {
      success: false,
      skillId: args.skillId,
      errorCode,
      ...(result.runId ? { runId: result.runId, resultKeys: Object.keys(results ?? {}), selectedResultKey: result.selectedResultKey,
        executionStatus: result.executionStatus, capabilityStatus: result.capabilityStatus } : {}),
      ...(failures.length ? { failedResultCount: failures.length, failedResults: failures.slice(0, 20).map(([resultKey, value]) => {
        const failure = value as Record<string, unknown>;
        const failureMeta = optionalRecord(failure.meta) ?? {};
        return { resultKey, errorCode: normalizeAnalysisErrorCode(failure.error_code, failure.errorCode),
          message: compactText(failure.message) ?? 'Analysis execution failed / 分析执行失败',
          diagnostics: pickAnalysisDiagnostics(failure, failureMeta) };
      }) } : {}),
      message: compactText(result.message ?? data.message)
        || (invalidResult
          ? 'Analysis returned no explicit success or failure status'
          : 'Analysis execution failed'),
      ...(diagnostics ? { diagnostics } : {}),
    };
  }

  const savedResults = optionalRecord(result.results);
  const selection = optionalRecord(result.selection);
  const entries = savedResults ? Object.entries(savedResults)
    : [[typeof result.selectedResultKey === 'string' ? result.selectedResultKey
      : typeof selection?.key === 'string' ? selection.key : 'analysis:default', result]] as const;
  const reactionTotals = Object.fromEntries(entries.flatMap(([key, selected]) => {
    if (!isRecord(selected) || isExplicitAnalysisFailure(selected) || !isExplicitAnalysisSuccess(selected)) return [];
    const totals = compactReactionTotals(getAnalysisPayload(selected), selected);
    return totals ? [[key, totals]] : [];
  }));

  return {
    success: true,
    skillId: args.skillId,
    ...(result.runId ? { runId: result.runId, resultKeys: isRecord(result.results) ? Object.keys(result.results) : [], selectedResultKey: result.selectedResultKey,
      executionStatus: result.executionStatus, capabilityStatus: result.capabilityStatus } : {}),
    analysisMode: data?.analysisMode,
    ...(Object.keys(reactionTotals).length ? { reactionTotals,
      reactionTotalsInstruction: 'Use this run\'s reactionTotals by exact result key; never reuse historical or draft physicsCheck totals. Values sum all solver reaction nodes, not the truncated response sample. mx/my/mz sum nodal reaction moments, excluding r×F, and are not resultant base moments about an origin. Missing components are unavailable, not zero. / 按准确结果键使用本次反力合计，不沿用历史或草稿physicsCheck总量；合计覆盖全部求解器反力节点。mx/my/mz仅为节点反力矩之和，不含力臂项，不是关于某原点的基底合矩；缺失分量不可视为零。' } : {}),
    ...(Array.isArray(data.sectionAssumptions) ? { sectionAssumptions: data.sectionAssumptions } : {}),
    ...(buildSuccessfulAnalysisDetails(data, result, args.model) ?? {}),
  };
}

export function buildModelToolSummary(
  model: Record<string, unknown>,
  locale: 'zh' | 'en' = 'zh',
): Record<string, unknown> {
  const nodeCount = Array.isArray(model.nodes) ? model.nodes.length : 0;
  const elementCount = Array.isArray(model.elements) ? model.elements.length : 0;
  const schemaVersion = model.schema_version;

  if (nodeCount === 0 || elementCount === 0) {
    return {
      success: false,
      errorCode: 'EMPTY_MODEL',
      message: locale === 'zh'
        ? '模型构建结果为空，未生成可分析的节点或单元。请重新提取参数或补充结构连接信息。'
        : 'Model build returned an empty model with no analyzable nodes or elements. Re-extract parameters or provide structural connectivity.',
      nodeCount,
      elementCount,
      schemaVersion,
    };
  }

  const placeholder = stiffnessPlaceholderOf(model);
  const metadata = isRecord(model.metadata) ? model.metadata : {};
  const assumptions = Array.isArray(metadata.templateAssumptions)
    ? metadata.templateAssumptions.filter(isRecord).map(row => String(row[locale])) : [];
  assumptions.push(...sectionAssumptions(model).map(row => row.message[locale]));
  return {
    success: true,
    nodeCount,
    elementCount,
    schemaVersion,
    ...(placeholder ? { stiffnessPlaceholder: { material: placeholder.material, section: placeholder.section,
      staticIndeterminacy: placeholder.staticIndeterminacy, equalStiffnessAssumed: placeholder.equalStiffnessAssumed,
      notice: placeholder.notice[locale] } } : {}),
    ...(assumptions.length ? { assumptions, assumptionInstruction: locale === 'zh' ? '在回答中说明这些建模假定。' : 'State these modelling assumptions in the answer.' } : {}),
    nextAction: 'run_analysis',
    message: locale === 'zh'
      ? '模型已构建完成。下一步必须调用 run_analysis 执行结构分析。'
      : 'Model build is complete. Next, call run_analysis to execute the structural analysis.',
  };
}

export function buildModelToolStateUpdate(
  model: Record<string, unknown>,
  summary: Record<string, unknown>,
  state?: AgentState,
): Partial<AgentState> {
  if (summary.success === false) {
    if (state?.model && !state.modelPending) return {};
    return {
      ...invalidateStaleResults(state),
      model: state?.model ?? null,
      modelPending: true,
    };
  }
  return commitModel(state, model, 'build_model');
}
