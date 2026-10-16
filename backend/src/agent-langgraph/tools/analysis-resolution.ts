import { analysisSkillLabel, getAnalysisSkillCatalogEntry, matchesAnalysisContext } from '../../agent-skills/analysis/catalog.js';
import { getAnalysisPayload } from './compaction/analysis.js';
import { isRecord, pickStringLike } from './shared.js';

function selectedAnalysisSkillIds(
  selectedSkillIds?: string[],
  analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear',
): string[] {
  return Array.isArray(selectedSkillIds)
    ? selectedSkillIds.filter((skillId) => {
      const entry = getAnalysisSkillCatalogEntry(skillId);
      return entry !== undefined && matchesAnalysisContext(entry, { analysisType });
    })
    : [];
}

export function resolveRequestedAnalysisSkillId(
  _message: string | undefined,
  selectedSkillIds?: string[],
  analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear',
  requestedAnalysisSkillId?: string,
): string | undefined {
  const analysisSkillIds = selectedAnalysisSkillIds(selectedSkillIds, analysisType);
  if (requestedAnalysisSkillId) {
    if (
      analysisSkillIds.includes(requestedAnalysisSkillId)
      && (!analysisType || getAnalysisSkillCatalogEntry(requestedAnalysisSkillId)?.analysisType === analysisType)
    ) {
      return requestedAnalysisSkillId;
    }
    return undefined;
  }

  return analysisSkillIds[0];
}

export function resolveRequestedAnalysisEngineId(
  message: string | undefined,
  selectedSkillIds?: string[],
  analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear',
  requestedAnalysisSkillId?: string,
): string | undefined {
  const skillId = resolveRequestedAnalysisSkillId(message, selectedSkillIds, analysisType, requestedAnalysisSkillId);
  return skillId ? getAnalysisSkillCatalogEntry(skillId)?.engineId : undefined;
}

export function resolveUnselectedRequestedAnalysisSkillId(
  _message: string | undefined,
  selectedSkillIds?: string[],
  analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear',
  requestedAnalysisSkillId?: string,
): string | undefined {
  const requested = getAnalysisSkillCatalogEntry(requestedAnalysisSkillId);
  if (!requestedAnalysisSkillId || !requested) {
    return undefined;
  }
  if (analysisType && requested.analysisType !== analysisType) {
    return requestedAnalysisSkillId;
  }
  const selected = selectedAnalysisSkillIds(selectedSkillIds, analysisType);
  const providerSatisfied = selected.some((skillId) =>
    skillId === requestedAnalysisSkillId || getAnalysisSkillCatalogEntry(skillId)?.engineId === requested.engineId);
  return providerSatisfied
    ? undefined
    : requestedAnalysisSkillId;
}

export function buildAnalysisProviderNotSelectedPayload(skillId: string) {
  const label = analysisSkillLabel(skillId);
  return {
    success: false,
    error_code: 'ANALYSIS_PROVIDER_NOT_SELECTED',
    requestedAnalysisSkillId: skillId,
    message: `The requested analysis provider (${label}) is not enabled in the current skill selection.`,
    messageZh: `当前会话未勾选请求的分析技能（${label}），不会改用其他分析引擎代跑。`,
  };
}

type ToolAnalysisType = 'static' | 'dynamic' | 'seismic' | 'nonlinear';

export function normalizeAnalysisType(value: unknown): ToolAnalysisType | undefined {
  return value === 'static' || value === 'dynamic' || value === 'seismic' || value === 'nonlinear'
    ? value
    : undefined;
}

function analysisResultRecord(analysis: unknown): Record<string, unknown> {
  return isRecord(analysis) ? analysis : {};
}

export function inferAnalysisTypeFromResult(analysis: unknown): ToolAnalysisType | undefined {
  const record = analysisResultRecord(analysis);
  const meta = isRecord(record.meta) ? record.meta : {};
  const data = isRecord(record.data) ? record.data : {};
  const direct = normalizeAnalysisType(meta.analysisType)
    ?? normalizeAnalysisType(meta.analysis_type)
    ?? normalizeAnalysisType(record.analysisType)
    ?? normalizeAnalysisType(record.analysis_type)
    ?? normalizeAnalysisType(record.type)
    ?? normalizeAnalysisType(data.analysisType)
    ?? normalizeAnalysisType(data.analysis_type)
    ?? normalizeAnalysisType(data.type);
  if (direct) {
    return direct;
  }
  const analysisMode = typeof data.analysisMode === 'string' ? data.analysisMode.toLowerCase() : '';
  const workflowInputMode = typeof data.workflowInputMode === 'string' ? data.workflowInputMode.toLowerCase() : '';
  if (analysisMode.includes('seismic') || workflowInputMode.includes('seismic')) {
    return 'seismic';
  }
  return undefined;
}

export function codeCheckSkillIdFromResult(codeCheck: unknown): string | undefined {
  if (!isRecord(codeCheck)) return undefined;
  const meta = isRecord(codeCheck.meta) ? codeCheck.meta : {};
  const skillId = typeof meta.codeCheckSkillId === 'string' ? meta.codeCheckSkillId.trim() : '';
  return skillId || undefined;
}

export function analysisTraceIdFromResult(analysis: unknown): string | undefined {
  if (!isRecord(analysis)) return undefined;
  const meta = isRecord(analysis.meta) ? analysis.meta : {};
  const traceId = typeof meta.traceId === 'string' ? meta.traceId.trim() : '';
  return traceId || undefined;
}

function codeCheckAnalysisTraceIdFromResult(codeCheck: unknown): string | undefined {
  if (!isRecord(codeCheck)) return undefined;
  const meta = isRecord(codeCheck.meta) ? codeCheck.meta : {};
  const traceId = typeof meta.analysisTraceId === 'string' ? meta.analysisTraceId.trim() : '';
  return traceId || undefined;
}

function codeCheckPayloadFromResult(codeCheck: Record<string, unknown>): Record<string, unknown> {
  const data = isRecord(codeCheck.data) ? codeCheck.data : {};
  return Object.keys(data).length > 0 ? data : codeCheck;
}

function hasGlobalSeismicCodeCheckDetail(codeCheck: Record<string, unknown>): boolean {
  const payload = codeCheckPayloadFromResult(codeCheck);
  const details = Array.isArray(payload.details) ? payload.details.filter(isRecord) : [];
  return details.some((detail) => {
    const elementId = typeof detail.elementId === 'string' ? detail.elementId.trim() : '';
    const elementType = typeof detail.elementType === 'string' ? detail.elementType.trim() : '';
    return elementId === '__global_seismic__' || elementType === 'global-seismic';
  });
}

export function hasValidChinaSeismicCodeCheck(codeCheck: unknown, analysis: unknown): boolean {
  if (!isRecord(codeCheck) || codeCheck.skipped === true) return false;
  const analysisTraceId = analysisTraceIdFromResult(analysis);
  const codeCheckAnalysisTraceId = codeCheckAnalysisTraceIdFromResult(codeCheck);
  if (analysisTraceId && codeCheckAnalysisTraceId !== analysisTraceId) {
    return false;
  }
  return codeCheckSkillIdFromResult(codeCheck) === 'code-check-gb50011'
    && hasGlobalSeismicCodeCheckDetail(codeCheck);
}

export function analysisWorkflowInputModeFromResult(analysis: unknown): string | undefined {
  if (!isRecord(analysis)) return undefined;
  const data = getAnalysisPayload(analysis);
  return pickStringLike(data, 'workflowInputMode') ?? pickStringLike(analysis, 'workflowInputMode') ?? undefined;
}
