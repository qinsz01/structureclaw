import { randomUUID } from 'node:crypto';
import { normalizeClarificationOptions } from '../utils/clarification-options.js';
import { nativeDesignRecord, resolveCheckProvider, type CodeCheckProvider } from '../engineering/native-design.js';
import { savedNativeDesignRecord } from '../engineering/native-design-options.js';
import { resultEngine } from '../engineering/result-data.js';
import { computeDraftMissing, buildDraftQuestions } from '../agent-runtime/draft-readiness.js';
/**
 * LangGraph tool definitions for the StructureClaw ReAct agent.
 *
 * Tools read dependencies from config.configurable (AgentConfigurable)
 * and state from the graph state via config.configurable.agentState.
 *
 * Artifact-writing tools (build_model, run_analysis, etc.) return
 * Command({ update }) objects to write directly into graph state channels,
 * eliminating the need for an extract_artifacts intermediary node.
 *
 * Custom streaming events are emitted via config.writer for real-time
 * tool status updates to the frontend.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentSkillRuntime } from '../agent-runtime/index.js';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { Command, interrupt } from '@langchain/langgraph';
import { ToolMessage } from '@langchain/core/messages';
import { getLogger, logToolCall } from '../utils/agent-logger.js';
import {
  createChatModel,
  mergeLlmTokenUsage,
  type LlmTokenUsage,
} from '../utils/llm.js';
import type { AgentState } from './state.js';
import type { AgentConfigurable } from './configurable.js';
import type {
  AgentSkillPlugin,
  DraftState,
  InteractionQuestion,
  StructuralTypeKey,
  StructuralTypeMatch,
} from '../agent-runtime/types.js';
import { isFreshGenericStructuralRoute } from '../agent-runtime/plugin-helpers.js';
import { loadAnalysisRun } from '../engineering/analysis-runs.js';
import { resultSelectionSchema, selectedSavedResult, quantityMatchesSelection, type ResultSelection } from '../engineering/result-selection.js';
import { createEngineeringReport, attachNativeReport } from '../services/engineering-report.js';
import { beginAnalysisRequest, beginNativeDesignRequest, commitModel, currentAnalysisError, invalidateAnalysis, modelHash, publishAnalysis, publishNativeDesign } from '../engineering/model-state.js';
import { analysisSettingsHash } from '../engineering/analysis-runs.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { checkRunResults, codeCheckFeedback } from '../engineering/code-checks.js';
import { assertAnalysisInputEvidenceMatchesRequest, assertInputEvidenceMatchesModel, mergeInputEvidence } from '../engineering/input-evidence.js';
import { currentRunPolicy, recordRunEvent, reserveToolCall, recordToolOutcome } from '../runtime/run-context.js';
import { createQueryResultsTool } from './model-tools.js';
import { requestScopeSchema, resolveExtractedScope, forceOnlyScope, missingInputReason, type RequestScope, type ScopeDiagnostic } from '../engineering/request-scope.js';
import { equilibriumModel } from '../engineering/beam-equilibrium.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exact requested scalars use the same query service and server-side tool budget. */
async function queryRequestedOutputs(state: AgentState, scope: RequestScope | null | undefined, config: LangGraphRunnableConfig) {
  const quantities: Record<string, Record<string, unknown>> = {};
  const missing: Array<Record<string, unknown>> = [];
  const outputs = scope?.outputs ?? [];
  for (const [index, selection] of outputs.entries()) {
    if (resultEngine(state.analysisResult ?? {}) === 'equilibrium' && !['forces', 'reactions'].includes(String(selection.field))) {
      missing.push({ selection, reason: 'RESPONSE_NOT_CALCULATED / 该响应尚未计算，需要对应分析属性' });
      continue;
    }
    const callId = `output-${randomUUID()}`;
    let reserved = false;
    try {
      reserveToolCall('query_results', callId);
      reserved = true;
      const command = await createQueryResultsTool().invoke(selection, {
        ...config, toolCall: { id: callId, name: 'query_results', args: selection }, configurable: { ...config.configurable, agentState: { ...state, resultQuantities: { ...state.resultQuantities, ...quantities } } },
      });
      if (command instanceof Command) Object.assign(quantities, command.update?.resultQuantities ?? {});
      recordToolOutcome('query_results', callId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reserved) recordToolOutcome('query_results', callId, reason);
      else recordRunEvent({ kind: 'requested_output_unavailable', selection, reason });
      missing.push({ selection, reason });
      // Do not spend further recovery attempts on a failed automatic query.
      missing.push(...outputs.slice(index + 1).map(selection => ({ selection, reason: 'NOT_QUERIED_AFTER_DELIVERY_FAILURE / 前项交付失败，尚未查询' })));
      break;
    }
  }
  return { resultQuantities: quantities, requestedQuantities: Object.values(quantities), missingRequestedOutputs: missing };
}

/** Get the AgentConfigurable from the LangGraph run config. */
function getConfigurable(config: LangGraphRunnableConfig): AgentConfigurable & { agentState?: AgentState } {
  return config.configurable as AgentConfigurable & { agentState?: AgentState };
}

/** Get the tool call ID from the LangChain config. */
function getToolCallId(config: LangGraphRunnableConfig): string {
  const id = (config as any).toolCall?.id;
  if (!id) throw new Error('Tool call ID not available in config');
  return id;
}

function messageRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const getType = record._getType;
  if (typeof getType === 'function') {
    return String(getType.call(message));
  }
  if (typeof record.role === 'string') return record.role;
  if (typeof record.type === 'string') return record.type;
  if (Array.isArray(record.id) && record.id.some((part) => String(part).includes('HumanMessage'))) {
    return 'human';
  }
  return null;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return content == null ? '' : String(content);
}

function latestHumanMessageText(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messageRole(messages[i]);
    if (role === 'human' || role === 'user') {
      return messageText(messages[i]).trim();
    }
  }
  return '';
}

const ATTACHMENT_DETAIL_MARKERS = [
  '[Attachment analysis:',
  '[附件解析:',
  '[Attachment vision summary:',
  '[附件视觉摘要:',
  '[Attachment vision summary unavailable:',
  '[附件视觉摘要不可用:',
];

function findAttachmentDetailsStart(message: string): number {
  return ATTACHMENT_DETAIL_MARKERS.reduce((best, marker) => {
    const index = message.indexOf(marker);
    if (index === -1) return best;
    return best === -1 ? index : Math.min(best, index);
  }, -1);
}

function hasAttachmentDetails(message: string | undefined): boolean {
  const text = message || '';
  return findAttachmentDetailsStart(text) !== -1;
}

function canonicalAttachmentDetailsOnly(message: string): string {
  const start = findAttachmentDetailsStart(message);
  return start === -1 ? '' : message.slice(start).trim();
}

function withCanonicalAttachmentDetails(message: string, canonicalUserMessage: string | undefined): string {
  const canonical = canonicalUserMessage?.trim();
  if (!canonical || !hasAttachmentDetails(canonical) || hasAttachmentDetails(message)) {
    return message;
  }
  const attachmentDetails = canonicalAttachmentDetailsOnly(canonical);
  return attachmentDetails ? `${message}\n\n${attachmentDetails}` : message;
}

export function resolveToolInputMessage(
  inputMessage: string | undefined,
  lastUserMessage: string | undefined,
  messages?: unknown[],
): string {
  const explicitMessage = inputMessage?.trim();
  if (explicitMessage) {
    return withCanonicalAttachmentDetails(explicitMessage, lastUserMessage);
  }
  const canonicalUserMessage = lastUserMessage?.trim();
  if (canonicalUserMessage) {
    return canonicalUserMessage;
  }
  const latestHumanMessage = latestHumanMessageText(messages);
  if (latestHumanMessage) {
    return latestHumanMessage;
  }
  return '';
}

const ANALYSIS_SKILL_ENGINE_IDS: Record<string, string> = {
  'opensees-static': 'builtin-opensees',
  'opensees-dynamic': 'builtin-opensees',
  'opensees-seismic': 'builtin-opensees',
  'opensees-nonlinear': 'builtin-opensees',
  'pkpm-static': 'builtin-pkpm',
  'yjk-static': 'builtin-yjk',
};

const ANALYSIS_SKILL_TYPES: Record<string, 'static' | 'dynamic' | 'seismic' | 'nonlinear'> = {
  'opensees-static': 'static',
  'opensees-dynamic': 'dynamic',
  'opensees-seismic': 'seismic',
  'opensees-nonlinear': 'nonlinear',
  'pkpm-static': 'static',
  'yjk-static': 'static',
};

const ANALYSIS_SKILL_LABELS: Record<string, string> = {
  'opensees-static': 'OpenSees static analysis',
  'opensees-dynamic': 'OpenSees dynamic analysis',
  'opensees-seismic': 'OpenSees seismic analysis',
  'opensees-nonlinear': 'OpenSees nonlinear analysis',
  'pkpm-static': 'PKPM/SATWE static analysis',
  'yjk-static': 'YJK static analysis',
};

const CHINA_SEISMIC_BASELINE_SKILL_IDS = [
  'generic',
  'frame',
  'concrete-frame',
  'opensees-seismic',
  'code-check-gb50011',
  'validation-structure-model',
  'report-export-builtin',
];

const ANALYSIS_SKILL_ID_VALUES = [
  'opensees-static',
  'opensees-dynamic',
  'opensees-seismic',
  'opensees-nonlinear',
  'pkpm-static',
  'yjk-static',
] as const;

export function detectRequestedAnalysisSkillId(_message: string | undefined): string | undefined {
  // Provider requests must arrive as structured analysisSkillId, not text matches.
  return undefined;
}

function selectedAnalysisSkillIds(
  selectedSkillIds?: string[],
  analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear',
): string[] {
  return Array.isArray(selectedSkillIds)
    ? selectedSkillIds.filter((skillId) =>
      ANALYSIS_SKILL_ENGINE_IDS[skillId]
      && (!analysisType || ANALYSIS_SKILL_TYPES[skillId] === analysisType))
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
      && (!analysisType || ANALYSIS_SKILL_TYPES[requestedAnalysisSkillId] === analysisType)
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
  return skillId ? ANALYSIS_SKILL_ENGINE_IDS[skillId] : undefined;
}

export function resolveUnselectedRequestedAnalysisSkillId(
  _message: string | undefined,
  selectedSkillIds?: string[],
  analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear',
  requestedAnalysisSkillId?: string,
): string | undefined {
  if (!requestedAnalysisSkillId || !ANALYSIS_SKILL_ENGINE_IDS[requestedAnalysisSkillId]) {
    return undefined;
  }
  if (analysisType && ANALYSIS_SKILL_TYPES[requestedAnalysisSkillId] !== analysisType) {
    return requestedAnalysisSkillId;
  }
  const selected = selectedAnalysisSkillIds(selectedSkillIds, analysisType);
  const requestedEngineId = ANALYSIS_SKILL_ENGINE_IDS[requestedAnalysisSkillId];
  const providerSatisfied = selected.some((skillId) =>
    skillId === requestedAnalysisSkillId || ANALYSIS_SKILL_ENGINE_IDS[skillId] === requestedEngineId);
  return providerSatisfied
    ? undefined
    : requestedAnalysisSkillId;
}

function buildAnalysisProviderNotSelectedPayload(skillId: string) {
  const label = ANALYSIS_SKILL_LABELS[skillId] ?? skillId;
  return {
    success: false,
    error_code: 'ANALYSIS_PROVIDER_NOT_SELECTED',
    requestedAnalysisSkillId: skillId,
    message: `The requested analysis provider (${label}) is not enabled in the current skill selection.`,
    messageZh: `当前会话未勾选请求的分析技能（${label}），不会改用其他分析引擎代跑。`,
  };
}

function parseSkillIdsJson(value: string): { ok: true; value: string[] } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'skillIdsJson must be a JSON array of strings.' };
    }
    return {
      ok: true,
      value: parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim()),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function isChinaSeismicSessionConfig(args: {
  analysisType?: string;
  designCode?: string;
  skillIds: string[];
}): boolean {
  const designCode = (args.designCode || '').toUpperCase();
  return args.analysisType === 'seismic'
    || designCode.includes('50011')
    || designCode.includes('55002')
    || args.skillIds.includes('opensees-seismic')
    || args.skillIds.includes('code-check-gb50011');
}

function completeChinaSeismicSkillIds(skillIds: string[]): string[] {
  const requested = new Set(skillIds);
  return uniqueStrings([
    ...CHINA_SEISMIC_BASELINE_SKILL_IDS,
    ...skillIds.filter((skillId) => !CHINA_SEISMIC_BASELINE_SKILL_IDS.includes(skillId)),
  ]).filter((skillId) => requested.has(skillId) || CHINA_SEISMIC_BASELINE_SKILL_IDS.includes(skillId));
}

/**
 * Create a Command that updates graph state channels AND adds a ToolMessage.
 * This is the recommended LangGraph pattern for tools that produce artifacts.
 */
function toolResult(
  toolCallId: string,
  toolName: string,
  content: string,
  stateUpdate?: Partial<AgentState>,
  llmUsage?: LlmTokenUsage,
): Command {
  return new Command({
    update: {
      ...(stateUpdate || {}),
      messages: [new ToolMessage({
        content,
        tool_call_id: toolCallId,
        name: toolName,
        ...(llmUsage
          ? {
              response_metadata: {
                tokenUsage: {
                  promptTokens: llmUsage.inputTokens,
                  completionTokens: llmUsage.outputTokens,
                  totalTokens: llmUsage.totalTokens,
                },
                tokenUsageSource: 'nested-model-call',
              },
            }
          : {}),
      })],
    },
  });
}

function nestedLlmUsageCollector(): {
  onUsage: ((usage: LlmTokenUsage) => void) | undefined;
  total: () => LlmTokenUsage | undefined;
} {
  const usages: LlmTokenUsage[] = [];
  return {
    onUsage: (usage) => usages.push(usage),
    total: () => mergeLlmTokenUsage(usages),
  };
}

type ParsedJsonObjectInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

type ToolAnalysisType = 'static' | 'dynamic' | 'seismic' | 'nonlinear';

function normalizeAnalysisType(value: unknown): ToolAnalysisType | undefined {
  return value === 'static' || value === 'dynamic' || value === 'seismic' || value === 'nonlinear'
    ? value
    : undefined;
}

function analysisResultRecord(analysis: unknown): Record<string, unknown> {
  return isRecord(analysis) ? analysis : {};
}

function inferAnalysisTypeFromResult(analysis: unknown): ToolAnalysisType | undefined {
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

function parseJsonObjectInput(value: string | undefined, fieldName: string): ParsedJsonObjectInput | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, error: `${fieldName} must be a JSON object.` };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${fieldName} is not valid JSON: ${message}` };
  }
}

function hasStructuredSeismicWorkflow(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function hasSemanticSeismicWorkflowInput(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  if (!hasStructuredSeismicWorkflow(value)) {
    return false;
  }
  const semanticTopLevelKeys = Object.keys(value).filter((key) =>
    !['groundMotionSet', 'groundMotions', 'groundMotionRecords', 'timeHistoryRecords'].includes(key));
  if (semanticTopLevelKeys.length > 0) {
    return true;
  }
  const groundMotionSet = isRecord(value.groundMotionSet) ? value.groundMotionSet : undefined;
  if (!groundMotionSet) {
    return false;
  }
  return Object.keys(groundMotionSet).some((key) =>
    !['source', 'uploadedAttachments', 'records'].includes(key));
}

function mergeStructuredRecords(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return override ? { ...override } : undefined;
  }
  if (!override) {
    return { ...base };
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    result[key] = isRecord(baseValue) && isRecord(value)
      ? mergeStructuredRecords(baseValue, value)
      : value;
  }
  return result;
}

function isUploadedGroundMotionContext(value: Record<string, unknown> | undefined): boolean {
  const groundMotionSet = isRecord(value?.groundMotionSet) ? value.groundMotionSet : undefined;
  if (!groundMotionSet) {
    return false;
  }
  const source = typeof groundMotionSet.source === 'string'
    ? groundMotionSet.source.trim().toLowerCase()
    : '';
  return source === 'uploaded'
    || Array.isArray(groundMotionSet.uploadedAttachments);
}

function shouldMergeUploadedGroundMotionContext(
  base: Record<string, unknown> | undefined,
  context: Record<string, unknown> | undefined,
): boolean {
  if (!isUploadedGroundMotionContext(context)) {
    return true;
  }
  const baseGroundMotionSet = isRecord(base?.groundMotionSet) ? base.groundMotionSet : undefined;
  const source = typeof baseGroundMotionSet?.source === 'string'
    ? baseGroundMotionSet.source.trim().toLowerCase()
    : '';
  return !source || source === 'uploaded';
}

function mergeSeismicWorkflowInputs(
  semanticWorkflow: Record<string, unknown> | undefined,
  contextWorkflow: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!semanticWorkflow) {
    return contextWorkflow ? { ...contextWorkflow } : undefined;
  }
  if (!contextWorkflow || !shouldMergeUploadedGroundMotionContext(semanticWorkflow, contextWorkflow)) {
    return { ...semanticWorkflow };
  }
  const merged = mergeStructuredRecords(semanticWorkflow, contextWorkflow) ?? {};
  const semanticSet = isRecord(semanticWorkflow.groundMotionSet) ? semanticWorkflow.groundMotionSet : {};
  const mergedSet = isRecord(merged.groundMotionSet) ? merged.groundMotionSet : {};
  if (Array.isArray(semanticSet.records) && Array.isArray(mergedSet.records)) {
    mergedSet.records = mergedSet.records.map(record => {
      if (!isRecord(record)) return record;
      const selected = (semanticSet.records as unknown[]).filter(isRecord).find(item => item.id !== undefined && item.id === record.id);
      if (!selected) return record;
      const settings = Object.fromEntries(Object.entries(selected).filter(([key]) => ['unit', 'direction', 'component', 'axis', 'seismicDirection',
        'dt', 'timeStep', 'time_step', 'timeUnit', 'timeColumn', 'accelerationColumn', 'accelColumn', 'valueColumn'].includes(key)));
      return { ...record, ...settings };
    });
  }
  return merged;
}

function isPositiveFiniteNumber(value: unknown): boolean {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function isPositiveIntegerLike(value: unknown): boolean {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function hasGroundMotionSource(record: Record<string, unknown>): boolean {
  if (isRecord(record.fileReference) && record.fileReference.format === 'sclaw-parsed-input-v1'
    && ['path', 'sha256', 'parsedPath', 'parsedSha256'].every(key => typeof (record.fileReference as Record<string, unknown>)[key] === 'string')) return true;
  if (
    Array.isArray(record['values'])
    || Array.isArray(record['accelerations'])
    || Array.isArray(record['accel'])
    || Array.isArray(record['rows'])
  ) {
    return true;
  }
  for (const key of ['content', 'text', 'csv', 'at2', 'data'] as const) {
    if (typeof record[key] === 'string' && record[key].trim().length > 0) {
      return true;
    }
  }
  for (const key of ['fileAnalysis', 'analysis', 'parsedFile', 'file'] as const) {
    const nested = record[key];
    if (isRecord(nested) && hasGroundMotionSource(nested)) {
      return true;
    }
  }
  return false;
}

function validateGroundMotionRecords(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${fieldPath} must be an array when provided.`);
    return;
  }
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${fieldPath}[${index}] must be an object.`);
      return;
    }
    if (!hasGroundMotionSource(item)) {
      errors.push(`${fieldPath}[${index}] must include values, rows, text/content, or parsed file data.`);
    }
  });
}

function localCatalogRecordIds(records: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(records)) {
    return ids;
  }
  records.forEach((item) => {
    if (!isRecord(item)) {
      return;
    }
    const id = item['id'] ?? item['catalogId'] ?? item['name'];
    if (typeof id === 'string' && id.trim()) {
      ids.add(id.trim());
    }
  });
  return ids;
}

function validateEarthquakeLevelValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'frequent',
    'minor',
    'small',
    'frequent_earthquake',
    'service',
    '多遇',
    '小震',
    '多遇地震',
    'fortification',
    'design',
    'moderate',
    'basic',
    'design_earthquake',
    '设防',
    '中震',
    '设防地震',
    'rare',
    'major',
    'large',
    'maximum',
    'rare_earthquake',
    'no_collapse',
    '罕遇',
    '大震',
    '罕遇地震',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be frequent, fortification, or rare when provided.`);
  }
}

function validateIntegerRangeValue(value: unknown, fieldPath: string, min: number, max: number, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    errors.push(`${fieldPath} must be an integer from ${min} to ${max} when provided.`);
  }
}

function validatePositiveNumberValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isPositiveFiniteNumber(value)) {
    errors.push(`${fieldPath} must be a positive number when provided.`);
  }
}

function validatePositiveFractionValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) {
    errors.push(`${fieldPath} must be greater than 0 and less than 1 when provided.`);
  }
}

function validateDesignGroupValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  if (!['1', '2', '3', '一', '二', '三', '第一组', '第二组', '第三组', 'group1', 'group2', 'group3', 'group 1', 'group 2', 'group 3'].includes(text)) {
    errors.push(`${fieldPath} must be one of 1, 2, or 3 when provided.`);
  }
}

function validateSiteCategoryValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toUpperCase().replace('类', '');
  if (!['0', '1', '2', '3', '4', 'I0', 'I1', 'I', 'II', 'III', 'IV'].includes(text)) {
    errors.push(`${fieldPath} must be one of I0, I1, I, II, III, or IV when provided.`);
  }
}

function validateFortificationCategoryValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'special',
    'key',
    'standard',
    'moderate',
    '甲',
    '甲类',
    '特殊设防类',
    '乙',
    '乙类',
    '重点设防类',
    '丙',
    '丙类',
    '标准设防类',
    '丁',
    '丁类',
    '适度设防类',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be special, key, standard, or moderate when provided.`);
  }
}

function validateRegularityValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'regular',
    'regularity_regular',
    '规则',
    'irregular',
    'general_irregular',
    '不规则',
    '一般不规则',
    'particularly_irregular',
    'special_irregular',
    'severe',
    'serious',
    '特别不规则',
    '严重不规则',
    'unknown',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be regular, irregular, or particularly_irregular when provided.`);
  }
}

function validateSeismicGradeValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 4) {
    return;
  }
  const text = String(value).trim().toLowerCase();
  const allowed = new Set([
    'i',
    'ii',
    'iii',
    'iv',
    'grade1',
    'grade2',
    'grade3',
    'grade4',
    'grade 1',
    'grade 2',
    'grade 3',
    'grade 4',
    'first',
    'second',
    'third',
    'fourth',
    '一级',
    '二级',
    '三级',
    '四级',
    '一',
    '二',
    '三',
    '四',
  ]);
  if (!allowed.has(text)) {
    errors.push(`${fieldPath} must be an integer from 1 to 4 when provided.`);
  }
}

function validateStoryCountValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isPositiveIntegerLike(value)) {
    errors.push(`${fieldPath} must be a positive integer when provided.`);
  }
}

function validateStructuredBooleanValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'string' && ['true', 'false', 'yes', 'no', '1', '0'].includes(value.trim().toLowerCase())) {
    return;
  }
  errors.push(`${fieldPath} must be a boolean when provided.`);
}

function validateSiteSeismicFields(siteSeismic: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validateIntegerRangeValue(siteSeismic['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(siteSeismic['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(siteSeismic['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(siteSeismic['basicAccelerationG'], `${fieldPath}.basicAccelerationG`, errors);
  validatePositiveNumberValue(siteSeismic['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateDesignGroupValue(siteSeismic['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(siteSeismic['design_group'], `${fieldPath}.design_group`, errors);
  validateSiteCategoryValue(siteSeismic['siteCategory'], `${fieldPath}.siteCategory`, errors);
  validateSiteCategoryValue(siteSeismic['site_category'], `${fieldPath}.site_category`, errors);
  validateSiteCategoryValue(siteSeismic['siteClass'], `${fieldPath}.siteClass`, errors);
  validatePositiveFractionValue(siteSeismic['dampingRatio'], `${fieldPath}.dampingRatio`, errors);
  validatePositiveFractionValue(siteSeismic['damping_ratio'], `${fieldPath}.damping_ratio`, errors);
  const zonationRecord = isRecord(siteSeismic['zonationRecord']) ? siteSeismic['zonationRecord'] : undefined;
  if (zonationRecord) {
    validateZonationTableValue(zonationRecord, `${fieldPath}.zonationRecord`, errors);
  }
}

function validateSeismicSafetyEvaluationValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  validateStructuredBooleanValue(value['approved'], `${fieldPath}.approved`, errors);
  validateIntegerRangeValue(value['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(value['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(value['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(value['basicAccelerationG'], `${fieldPath}.basicAccelerationG`, errors);
  validatePositiveNumberValue(value['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateDesignGroupValue(value['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(value['design_group'], `${fieldPath}.design_group`, errors);
  validatePositiveNumberValue(value['characteristicPeriod'], `${fieldPath}.characteristicPeriod`, errors);
  validatePositiveNumberValue(value['characteristic_period'], `${fieldPath}.characteristic_period`, errors);
  validatePositiveNumberValue(value['Tg'], `${fieldPath}.Tg`, errors);
  validatePositiveNumberValue(value['rareCharacteristicPeriod'], `${fieldPath}.rareCharacteristicPeriod`, errors);
  validatePositiveNumberValue(value['rare_characteristic_period'], `${fieldPath}.rare_characteristic_period`, errors);
  validatePositiveNumberValue(value['rareTg'], `${fieldPath}.rareTg`, errors);
  validatePositiveNumberValue(value['maxInfluenceCoefficient'], `${fieldPath}.maxInfluenceCoefficient`, errors);
  validatePositiveNumberValue(value['alphaMax'], `${fieldPath}.alphaMax`, errors);
}

const STRUCTURED_REVIEW_TRACE_KEYS = [
  'overLimitReview',
  'specialReview',
  'specialSeismicReview',
  'overLimitSpecialReview',
] as const;

const STRUCTURED_REVIEW_BOOLEAN_KEYS = [
  'reviewRequired',
  'required',
  'requiresReview',
  'overLimitReviewRequired',
  'requiresOverLimitReview',
  'specialReviewRequired',
  'requiresSpecialReview',
  'specialSeismicReviewRequired',
  'approved',
  'reviewApproved',
  'approvalProvided',
  'reviewCompleted',
  'completed',
  'provided',
  'expertReviewProvided',
  'expertReviewCompleted',
] as const;

const STRUCTURED_REVIEW_STRING_KEYS = [
  'status',
  'reviewStatus',
  'approvalStatus',
  'conclusion',
  'reviewConclusion',
  'approvalConclusion',
  'reviewType',
  'type',
  'approvalId',
  'reviewId',
  'reportId',
  'authority',
  'reviewAuthority',
  'date',
  'reviewDate',
  'approvalDate',
] as const;

const STRUCTURED_REVIEW_REASON_KEYS = [
  'reasons',
  'reviewReasons',
  'overLimitReasons',
  'specialReviewReasons',
] as const;

function validateOptionalNonEmptyStringValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${fieldPath} must be a non-empty string when provided.`);
  }
}

function validateOptionalStringOrStringArrayValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (!value.trim()) {
      errors.push(`${fieldPath} must be a string or an array of non-empty strings when provided.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string' || !item.trim())) {
      errors.push(`${fieldPath} must contain only non-empty strings when provided.`);
    }
    return;
  }
  errors.push(`${fieldPath} must be a string or an array of non-empty strings when provided.`);
}

function validateStructuredReviewTraceFields(review: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  for (const key of STRUCTURED_REVIEW_BOOLEAN_KEYS) {
    validateStructuredBooleanValue(review[key], `${fieldPath}.${key}`, errors);
  }
  for (const key of STRUCTURED_REVIEW_STRING_KEYS) {
    validateOptionalNonEmptyStringValue(review[key], `${fieldPath}.${key}`, errors);
  }
  for (const key of STRUCTURED_REVIEW_REASON_KEYS) {
    validateOptionalStringOrStringArrayValue(review[key], `${fieldPath}.${key}`, errors);
  }
}

function validateStructuredReviewTraceValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  validateStructuredReviewTraceFields(value, fieldPath, errors);
}

function validateStructuredReviewTraceFieldsInRecord(record: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  for (const key of STRUCTURED_REVIEW_TRACE_KEYS) {
    const reviewFieldPath = fieldPath ? `${fieldPath}.${key}` : key;
    validateStructuredReviewTraceValue(record[key], reviewFieldPath, errors);
  }
}

function validateRegularityAssessmentReviewFields(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  for (const key of STRUCTURED_REVIEW_BOOLEAN_KEYS) {
    validateStructuredBooleanValue(value[key], `${fieldPath}.${key}`, errors);
  }
  for (const key of STRUCTURED_REVIEW_REASON_KEYS) {
    validateOptionalStringOrStringArrayValue(value[key], `${fieldPath}.${key}`, errors);
  }
}

function zonationRecordHasParameter(record: Record<string, unknown>): boolean {
  return Boolean(
    record['accelerationG'] !== undefined
    || record['acceleration_g'] !== undefined
    || record['basicAccelerationG'] !== undefined
    || record['designBasicAccelerationG'] !== undefined
    || record['pgaG'] !== undefined
    || record['peakAccelerationG'] !== undefined
    || record['amaxG'] !== undefined
    || record['intensity'] !== undefined
    || record['seismicIntensity'] !== undefined
    || record['fortificationIntensity'] !== undefined
    || record['designGroup'] !== undefined
    || record['design_group'] !== undefined
    || record['earthquakeGroup'] !== undefined
    || record['characteristicPeriod'] !== undefined
    || record['characteristic_period'] !== undefined
    || record['Tg'] !== undefined
    || record['tg'] !== undefined
    || record['maxInfluenceCoefficient'] !== undefined
    || record['max_influence_coefficient'] !== undefined
    || record['alphaMax'] !== undefined
  );
}

function validateZonationRecordFields(record: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  if (!zonationRecordHasParameter(record)) {
    errors.push(`${fieldPath} must include acceleration, intensity, design group, characteristic period, or alphaMax.`);
  }
  validateIntegerRangeValue(record['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validateIntegerRangeValue(record['seismicIntensity'], `${fieldPath}.seismicIntensity`, 6, 9, errors);
  validateIntegerRangeValue(record['fortificationIntensity'], `${fieldPath}.fortificationIntensity`, 6, 9, errors);
  validatePositiveNumberValue(record['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(record['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(record['basicAccelerationG'], `${fieldPath}.basicAccelerationG`, errors);
  validatePositiveNumberValue(record['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validatePositiveNumberValue(record['pgaG'], `${fieldPath}.pgaG`, errors);
  validatePositiveNumberValue(record['peakAccelerationG'], `${fieldPath}.peakAccelerationG`, errors);
  validatePositiveNumberValue(record['amaxG'], `${fieldPath}.amaxG`, errors);
  validateDesignGroupValue(record['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(record['design_group'], `${fieldPath}.design_group`, errors);
  validateDesignGroupValue(record['earthquakeGroup'], `${fieldPath}.earthquakeGroup`, errors);
  validatePositiveNumberValue(record['characteristicPeriod'], `${fieldPath}.characteristicPeriod`, errors);
  validatePositiveNumberValue(record['characteristic_period'], `${fieldPath}.characteristic_period`, errors);
  validatePositiveNumberValue(record['Tg'], `${fieldPath}.Tg`, errors);
  validatePositiveNumberValue(record['tg'], `${fieldPath}.tg`, errors);
  validatePositiveNumberValue(record['maxInfluenceCoefficient'], `${fieldPath}.maxInfluenceCoefficient`, errors);
  validatePositiveNumberValue(record['max_influence_coefficient'], `${fieldPath}.max_influence_coefficient`, errors);
  validatePositiveNumberValue(record['alphaMax'], `${fieldPath}.alphaMax`, errors);
}

function validateZonationRecords(records: unknown, fieldPath: string, errors: string[]): void {
  if (!Array.isArray(records)) {
    errors.push(`${fieldPath} must be an array when provided.`);
    return;
  }
  if (records.length === 0) {
    errors.push(`${fieldPath} must contain at least one record.`);
    return;
  }
  records.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${fieldPath}[${index}] must be an object.`);
      return;
    }
    validateZonationRecordFields(item, `${fieldPath}[${index}]`, errors);
  });
}

function isZonationParameterKey(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }
  const key = String(value).trim();
  return [
    'accelerationG',
    'acceleration_g',
    'basicAccelerationG',
    'designBasicAccelerationG',
    'pgaG',
    'peakAccelerationG',
    'amaxG',
    'intensity',
    'seismicIntensity',
    'fortificationIntensity',
    'designGroup',
    'design_group',
    'earthquakeGroup',
    'characteristicPeriod',
    'characteristic_period',
    'Tg',
    'tg',
    'maxInfluenceCoefficient',
    'max_influence_coefficient',
    'alphaMax',
  ].includes(key);
}

function validateZonationTableValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    validateZonationRecords(value, fieldPath, errors);
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object or an array of records when provided.`);
    return;
  }
  if (value['records'] !== undefined) {
    validateZonationRecords(value['records'], `${fieldPath}.records`, errors);
    return;
  }
  if (value['headers'] !== undefined || value['rows'] !== undefined) {
    if (!Array.isArray(value['headers']) || !Array.isArray(value['rows'])) {
      errors.push(`${fieldPath}.headers and ${fieldPath}.rows must both be arrays when provided.`);
      return;
    }
    if ((value['headers'] as unknown[]).length === 0 || (value['rows'] as unknown[]).length === 0) {
      errors.push(`${fieldPath}.headers and ${fieldPath}.rows must not be empty when provided.`);
    }
    if (!(value['headers'] as unknown[]).some((header) => isZonationParameterKey(header))) {
      errors.push(`${fieldPath}.headers must include acceleration, intensity, design group, characteristic period, or alphaMax.`);
    }
    if (!(value['rows'] as unknown[]).every((row) => Array.isArray(row))) {
      errors.push(`${fieldPath}.rows must contain row arrays.`);
    }
    return;
  }
  validateZonationRecordFields(value, fieldPath, errors);
}

function validateDesignBasisFields(designBasis: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validateIntegerRangeValue(designBasis['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(designBasis['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(designBasis['acceleration_g'], `${fieldPath}.acceleration_g`, errors);
  validatePositiveNumberValue(designBasis['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateDesignGroupValue(designBasis['designGroup'], `${fieldPath}.designGroup`, errors);
  validateDesignGroupValue(designBasis['design_group'], `${fieldPath}.design_group`, errors);
  validateSiteCategoryValue(designBasis['siteCategory'], `${fieldPath}.siteCategory`, errors);
  validateSiteCategoryValue(designBasis['site_category'], `${fieldPath}.site_category`, errors);
  validatePositiveFractionValue(designBasis['dampingRatio'], `${fieldPath}.dampingRatio`, errors);
  validatePositiveFractionValue(designBasis['damping_ratio'], `${fieldPath}.damping_ratio`, errors);
  validateFortificationCategoryValue(designBasis['fortificationCategory'], `${fieldPath}.fortificationCategory`, errors);
  validateSeismicGradeValue(designBasis['seismicGrade'], `${fieldPath}.seismicGrade`, errors);
  validateSeismicGradeValue(designBasis['antiSeismicGrade'], `${fieldPath}.antiSeismicGrade`, errors);
  validatePositiveNumberValue(designBasis['heightM'], `${fieldPath}.heightM`, errors);
  validatePositiveNumberValue(designBasis['totalHeightM'], `${fieldPath}.totalHeightM`, errors);
  validateStoryCountValue(designBasis['storyCount'], `${fieldPath}.storyCount`, errors);
  validateSeismicSafetyEvaluationValue(designBasis['seismicSafetyEvaluation'], `${fieldPath}.seismicSafetyEvaluation`, errors);
  validateSeismicSafetyEvaluationValue(designBasis['safetyEvaluation'], `${fieldPath}.safetyEvaluation`, errors);
  validateZonationTableValue(designBasis['groundMotionZonation'], `${fieldPath}.groundMotionZonation`, errors);
  validateZonationTableValue(designBasis['zonation'], `${fieldPath}.zonation`, errors);
  validateZonationTableValue(designBasis['zonationRecords'], `${fieldPath}.zonationRecords`, errors);
  const siteSeismic = isRecord(designBasis['siteSeismic']) ? designBasis['siteSeismic'] : undefined;
  if (siteSeismic) {
    validateSiteSeismicFields(siteSeismic, `${fieldPath}.siteSeismic`, errors);
  }
  validateStructuredReviewTraceFieldsInRecord(designBasis, fieldPath, errors);
}

function validatePerformanceObjectiveValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (!value.trim()) {
      errors.push(`${fieldPath} must be a non-empty string or an object when provided.`);
    }
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be a string or an object when provided.`);
    return;
  }
  validatePositiveFractionValue(value['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePositiveFractionValue(value['limitDriftRatio'], `${fieldPath}.limitDriftRatio`, errors);
  validatePositiveNumberValue(value['targetDisplacement'], `${fieldPath}.targetDisplacement`, errors);
  validatePositiveNumberValue(value['performanceTargetDisplacement'], `${fieldPath}.performanceTargetDisplacement`, errors);
}

function validateDesignRequirementFields(requirements: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validateIntegerRangeValue(requirements['intensity'], `${fieldPath}.intensity`, 6, 9, errors);
  validatePositiveNumberValue(requirements['accelerationG'], `${fieldPath}.accelerationG`, errors);
  validatePositiveNumberValue(requirements['designBasicAccelerationG'], `${fieldPath}.designBasicAccelerationG`, errors);
  validateFortificationCategoryValue(requirements['fortificationCategory'], `${fieldPath}.fortificationCategory`, errors);
  validateSeismicGradeValue(requirements['seismicGrade'], `${fieldPath}.seismicGrade`, errors);
  validateSeismicGradeValue(requirements['antiSeismicGrade'], `${fieldPath}.antiSeismicGrade`, errors);
  validateRegularityValue(requirements['irregularity'], `${fieldPath}.irregularity`, errors);
  validateRegularityValue(requirements['regularity'], `${fieldPath}.regularity`, errors);
  validatePositiveFractionValue(requirements['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePerformanceObjectiveValue(requirements['performanceObjective'], `${fieldPath}.performanceObjective`, errors);
  validateSeismicSafetyEvaluationValue(requirements['seismicSafetyEvaluation'], `${fieldPath}.seismicSafetyEvaluation`, errors);
  validateSeismicSafetyEvaluationValue(requirements['safetyEvaluation'], `${fieldPath}.safetyEvaluation`, errors);
  for (const key of [
    'supplementaryTimeHistory',
    'requiresTimeHistory',
    'requiresVerticalSeismic',
    'requiresElasticPlasticDeformation',
    'requiresPerformanceBasedCheck',
    'hasLargeSpan',
    'hasLongCantilever',
    'hasIsolation',
    'hasEnergyDissipation',
    'hasEnergyDissipationSystem',
    'hasDampingDevice',
  ] as const) {
    validateStructuredBooleanValue(requirements[key], `${fieldPath}.${key}`, errors);
  }
}

function validateStructureProfileFields(structure: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validatePositiveNumberValue(structure['heightM'], `${fieldPath}.heightM`, errors);
  validatePositiveNumberValue(structure['totalHeightM'], `${fieldPath}.totalHeightM`, errors);
  validateStoryCountValue(structure['storyCount'], `${fieldPath}.storyCount`, errors);
  validateSeismicGradeValue(structure['seismicGrade'], `${fieldPath}.seismicGrade`, errors);
  validateRegularityValue(structure['regularity'], `${fieldPath}.regularity`, errors);
  validateRegularityValue(structure['irregularity'], `${fieldPath}.irregularity`, errors);
  for (const key of ['hasLargeSpan', 'hasLongCantilever', 'hasIsolation', 'hasEnergyDissipation', 'hasEnergyDissipationSystem', 'hasDampingDevice', 'isHighRise', 'highRise'] as const) {
    validateStructuredBooleanValue(structure[key], `${fieldPath}.${key}`, errors);
  }
}

function validatePushoverFields(pushover: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validatePositiveNumberValue(pushover['targetDisplacement'], `${fieldPath}.targetDisplacement`, errors);
  validatePositiveNumberValue(pushover['performanceTargetDisplacement'], `${fieldPath}.performanceTargetDisplacement`, errors);
  validatePositiveNumberValue(pushover['performancePointDisplacement'], `${fieldPath}.performancePointDisplacement`, errors);
  validatePositiveFractionValue(pushover['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePositiveIntegerValue(pushover['steps'], `${fieldPath}.steps`, errors);
  validatePerformanceObjectiveValue(pushover['performanceObjective'], `${fieldPath}.performanceObjective`, errors);
}

function validateElasticPlasticTimeHistoryFields(section: Record<string, unknown>, fieldPath: string, errors: string[]): void {
  validatePositiveFractionValue(section['acceptanceDriftRatio'], `${fieldPath}.acceptanceDriftRatio`, errors);
  validatePerformanceObjectiveValue(section['performanceObjective'], `${fieldPath}.performanceObjective`, errors);
}

function validatePositiveIntegerValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isPositiveIntegerLike(value)) {
    errors.push(`${fieldPath} must be a positive integer when provided.`);
  }
}

function validateNonlinearModelValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
    return;
  }
  const hinges = value['memberPlasticHinges'];
  if (hinges !== undefined) {
    if (!Array.isArray(hinges)) {
      errors.push(`${fieldPath}.memberPlasticHinges must be an array when provided.`);
    } else if (hinges.some((item) => !isRecord(item))) {
      errors.push(`${fieldPath}.memberPlasticHinges must contain only objects when provided.`);
    }
  }
}

function validateOptionalRecordValue(value: unknown, fieldPath: string, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${fieldPath} must be an object when provided.`);
  }
}

function validateSeismicWorkflowInput(workflow: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const method = workflow['methodPreference'] ?? workflow['method'] ?? workflow['analysisMethod'];
  if (method !== undefined) {
    const text = String(method).trim().toLowerCase();
    if (!['auto', 'response_spectrum', 'time_history', 'pushover', 'elastic_plastic_time_history'].includes(text)) {
      errors.push('methodPreference must be one of auto, response_spectrum, time_history, pushover, or elastic_plastic_time_history.');
    }
  }

  const directions = workflow['directions'];
  if (directions !== undefined) {
    if (!Array.isArray(directions) || directions.some((direction) => !['x', 'y'].includes(String(direction).trim().toLowerCase()))) {
      errors.push('directions must be an array containing only x and/or y.');
    }
  }

  const responseSpectrum = isRecord(workflow['responseSpectrum']) ? workflow['responseSpectrum'] : undefined;
  const modalCombination = responseSpectrum?.['modalCombination'];
  if (modalCombination !== undefined) {
    const text = String(modalCombination).trim().toLowerCase();
    if (!['cqc', 'srss'].includes(text)) {
      errors.push('responseSpectrum.modalCombination must be cqc or srss.');
    }
  }

  validateEarthquakeLevelValue(workflow['earthquakeLevel'], 'earthquakeLevel', errors);
  validatePositiveFractionValue(workflow['dampingRatio'], 'dampingRatio', errors);
  validateFortificationCategoryValue(workflow['fortificationCategory'], 'fortificationCategory', errors);
  validateSeismicGradeValue(workflow['seismicGrade'], 'seismicGrade', errors);
  validatePositiveNumberValue(workflow['heightM'], 'heightM', errors);
  validateStoryCountValue(workflow['storyCount'], 'storyCount', errors);
  validateRegularityValue(workflow['irregularity'], 'irregularity', errors);
  validateRegularityValue(workflow['regularity'], 'regularity', errors);
  validateZonationTableValue(workflow['groundMotionZonation'], 'groundMotionZonation', errors);
  validateZonationTableValue(workflow['zonation'], 'zonation', errors);
  validateZonationTableValue(workflow['zonationRecords'], 'zonationRecords', errors);
  validatePerformanceObjectiveValue(workflow['performanceObjective'], 'performanceObjective', errors);
  validateSeismicSafetyEvaluationValue(workflow['seismicSafetyEvaluation'], 'seismicSafetyEvaluation', errors);
  validateSeismicSafetyEvaluationValue(workflow['safetyEvaluation'], 'safetyEvaluation', errors);
  validateNonlinearModelValue(workflow['nonlinearModel'], 'nonlinearModel', errors);
  validateOptionalRecordValue(workflow['isolationSystem'], 'isolationSystem', errors);
  validateOptionalRecordValue(workflow['baseIsolationSystem'], 'baseIsolationSystem', errors);
  validateOptionalRecordValue(workflow['energyDissipationSystem'], 'energyDissipationSystem', errors);
  validateOptionalRecordValue(workflow['dampingSystem'], 'dampingSystem', errors);
  validateOptionalRecordValue(workflow['dampingDevices'], 'dampingDevices', errors);
  validateStructuredReviewTraceFieldsInRecord(workflow, '', errors);
  validateRegularityAssessmentReviewFields(workflow['regularityAssessment'], 'regularityAssessment', errors);
  for (const key of [
    'requiresTimeHistory',
    'requiresVerticalSeismic',
    'requiresElasticPlasticDeformation',
    'requiresPerformanceBasedCheck',
    'hasLargeSpan',
    'hasLongCantilever',
    'hasIsolation',
    'hasEnergyDissipation',
    'hasEnergyDissipationSystem',
    'hasDampingDevice',
    'isHighRise',
    'highRise',
  ] as const) {
    validateStructuredBooleanValue(workflow[key], key, errors);
  }
  const workflowSiteSeismic = isRecord(workflow['siteSeismic']) ? workflow['siteSeismic'] : undefined;
  if (workflowSiteSeismic) {
    validateSiteSeismicFields(workflowSiteSeismic, 'siteSeismic', errors);
  }
  const analysisControl = isRecord(workflow['analysisControl']) ? workflow['analysisControl'] : undefined;
  if (analysisControl) {
    validatePositiveFractionValue(analysisControl['dampingRatio'], 'analysisControl.dampingRatio', errors);
    validatePositiveFractionValue(analysisControl['damping_ratio'], 'analysisControl.damping_ratio', errors);
    validatePositiveNumberValue(analysisControl['targetDisplacement'], 'analysisControl.targetDisplacement', errors);
    validatePositiveNumberValue(analysisControl['performanceTargetDisplacement'], 'analysisControl.performanceTargetDisplacement', errors);
    validatePerformanceObjectiveValue(analysisControl['performanceObjective'], 'analysisControl.performanceObjective', errors);
  }
  const pushover = isRecord(workflow['pushover']) ? workflow['pushover'] : undefined;
  if (pushover) {
    validatePushoverFields(pushover, 'pushover', errors);
  } else if (workflow['pushover'] !== undefined) {
    errors.push('pushover must be an object when provided.');
  }
  const elasticPlasticTimeHistory = isRecord(workflow['elasticPlasticTimeHistory']) ? workflow['elasticPlasticTimeHistory'] : undefined;
  if (elasticPlasticTimeHistory) {
    validateElasticPlasticTimeHistoryFields(elasticPlasticTimeHistory, 'elasticPlasticTimeHistory', errors);
  } else if (workflow['elasticPlasticTimeHistory'] !== undefined) {
    errors.push('elasticPlasticTimeHistory must be an object when provided.');
  }
  const nonlinearTimeHistory = isRecord(workflow['nonlinearTimeHistory']) ? workflow['nonlinearTimeHistory'] : undefined;
  if (nonlinearTimeHistory) {
    validateElasticPlasticTimeHistoryFields(nonlinearTimeHistory, 'nonlinearTimeHistory', errors);
  } else if (workflow['nonlinearTimeHistory'] !== undefined) {
    errors.push('nonlinearTimeHistory must be an object when provided.');
  }
  const designBasis = isRecord(workflow['designBasis']) ? workflow['designBasis'] : undefined;
  if (designBasis) {
    validateEarthquakeLevelValue(designBasis['earthquakeLevel'], 'designBasis.earthquakeLevel', errors);
    validateDesignBasisFields(designBasis, 'designBasis', errors);
    const siteSeismic = isRecord(designBasis['siteSeismic']) ? designBasis['siteSeismic'] : undefined;
    if (siteSeismic) {
      validateEarthquakeLevelValue(siteSeismic['earthquakeLevel'], 'designBasis.siteSeismic.earthquakeLevel', errors);
    }
  }
  const designRequirements = isRecord(workflow['designRequirements']) ? workflow['designRequirements'] : undefined;
  if (designRequirements) {
    validateEarthquakeLevelValue(designRequirements['earthquakeLevel'], 'designRequirements.earthquakeLevel', errors);
    validateEarthquakeLevelValue(designRequirements['targetEarthquakeLevel'], 'designRequirements.targetEarthquakeLevel', errors);
    validateDesignRequirementFields(designRequirements, 'designRequirements', errors);
  }
  const methodDecision = isRecord(workflow['methodDecision']) ? workflow['methodDecision'] : undefined;
  if (methodDecision) {
    validateStructuredReviewTraceFieldsInRecord(methodDecision, 'methodDecision', errors);
  } else if (workflow['methodDecision'] !== undefined) {
    errors.push('methodDecision must be an object when provided.');
  }
  const structure = isRecord(workflow['structure']) ? workflow['structure'] : undefined;
  if (structure) {
    validateStructureProfileFields(structure, 'structure', errors);
  }
  const structureProfile = isRecord(workflow['structureProfile']) ? workflow['structureProfile'] : undefined;
  if (structureProfile) {
    validateStructureProfileFields(structureProfile, 'structureProfile', errors);
  }
  const groundMotionRequirement = isRecord(workflow['groundMotionRequirement']) ? workflow['groundMotionRequirement'] : undefined;
  if (groundMotionRequirement) {
    validateEarthquakeLevelValue(groundMotionRequirement['targetEarthquakeLevel'], 'groundMotionRequirement.targetEarthquakeLevel', errors);
  }

  const groundMotionSet = isRecord(workflow['groundMotionSet']) ? workflow['groundMotionSet'] : undefined;
  if (groundMotionSet) {
    validateGroundMotionRecords(groundMotionSet['records'], 'groundMotionSet.records', errors);
    for (const key of ['requiredCount', 'expectedCount'] as const) {
      if (groundMotionSet[key] !== undefined && !isPositiveIntegerLike(groundMotionSet[key])) {
        errors.push(`groundMotionSet.${key} must be a positive integer when provided.`);
      }
    }
    const catalogIds = groundMotionSet['catalogIds'];
    if (
      catalogIds !== undefined
      && (!Array.isArray(catalogIds) || catalogIds.some((item) => typeof item !== 'string' || !item.trim()))
    ) {
      errors.push('groundMotionSet.catalogIds must be an array of non-empty strings when provided.');
    }
    const localCatalog = isRecord(groundMotionSet['localCatalog']) ? groundMotionSet['localCatalog'] : undefined;
    if (localCatalog) {
      validateGroundMotionRecords(localCatalog['records'], 'groundMotionSet.localCatalog.records', errors);
    }
    const source = typeof groundMotionSet['source'] === 'string' ? groundMotionSet['source'].trim().toLowerCase() : '';
    const hasDirectRecords = Array.isArray(groundMotionSet['records']) && groundMotionSet['records'].length > 0;
    if (source === 'uploaded' && !hasDirectRecords) {
      errors.push('groundMotionSet.records is required when source is uploaded; analyze uploaded files and preserve CSV rows or AT2/TXT content in records before running analysis.');
    }
    const hasLocalCatalogRecords = Array.isArray(localCatalog?.['records']);
    if (
      ['local_catalog', 'licensed_catalog', 'project_catalog'].includes(source)
      && !hasLocalCatalogRecords
      && groundMotionSet['records'] === undefined
    ) {
      errors.push('groundMotionSet.localCatalog.records or groundMotionSet.records is required when source is local_catalog, licensed_catalog, or project_catalog.');
    }
    if (catalogIds !== undefined && localCatalog) {
      const ids = localCatalogRecordIds(localCatalog['records']);
      const missingIds = Array.isArray(catalogIds)
        ? catalogIds.filter((item) => typeof item === 'string' && item.trim() && !ids.has(item.trim()))
        : [];
      if (missingIds.length > 0) {
        errors.push(`groundMotionSet.catalogIds not found in localCatalog.records: ${missingIds.join(', ')}.`);
      }
    }
    const scaleFactorLimit = groundMotionSet['scaleFactorLimit'];
    if (scaleFactorLimit !== undefined && !isPositiveFiniteNumber(scaleFactorLimit)) {
      errors.push('groundMotionSet.scaleFactorLimit must be a positive number when provided.');
    }
  }

  return errors;
}

function buildDraftProgress(
  locale: 'zh' | 'en',
  criticalMissing: string[],
): { canProceed: boolean; nextAction: 'ask_user_clarification' | 'build_model'; reason?: string; instruction: string } {
  if (criticalMissing.length === 0) {
    return {
      canProceed: true,
      nextAction: 'build_model',
      instruction: locale === 'zh'
        ? 'criticalMissing 为空。下一步调用 build_model；不要因为可默认或非关键的 draftIssues 先追问。'
        : 'criticalMissing is empty. Call build_model next; do not ask for clarification first just because defaultable or non-critical draftIssues are present.',
    };
  }
  const missingText = criticalMissing.join(', ');
  return {
    canProceed: false,
    nextAction: 'ask_user_clarification',
    instruction: locale === 'zh'
      ? '存在关键缺失字段。下一步调用 ask_user_clarification；不要调用 build_model。'
      : 'Critical fields are missing. Call ask_user_clarification next; do not call build_model.',
    reason: locale === 'zh'
      ? `草稿仍缺少关键参数：${missingText}。需要继续向用户澄清，不能直接构建模型或写入 memory。`
      : `The draft is still missing critical parameters: ${missingText}. Continue by asking the user for clarification; do not build the model or store draft values in memory.`,
  };
}

function buildPluginUnavailableProgress(
  locale: 'zh' | 'en',
): { canProceed: false; nextAction: 'ask_user_clarification'; reason: string } {
  return {
    canProceed: false,
    nextAction: 'ask_user_clarification',
    reason: locale === 'zh'
      ? '已保留上一版有效草稿，但无法解析对应结构类型插件，不能可靠计算缺失字段或继续建模。请先确认结构类型或恢复可用 skillScope。'
      : 'The previous valid draft was preserved, but its structure-type plugin could not be resolved. Missing fields cannot be computed reliably, so ask the user to confirm the structural type or restore the available skill scope before building a model.',
  };
}

function buildClarificationQuestions(
  plugin: AgentSkillPlugin | null | undefined,
  criticalMissing: string[],
  optionalMissing: string[],
  state: DraftState,
  locale: 'zh' | 'en',
): InteractionQuestion[] {
  return buildDraftQuestions(plugin, criticalMissing, optionalMissing, state, locale);
}

function hasStableDraftType(state: DraftState | null | undefined): state is DraftState {
  return !!state?.inferredType && state.inferredType !== 'unknown';
}

export function shouldPreserveExistingDraftState(
  existingState: DraftState | null | undefined,
  structuralTypeMatch: StructuralTypeMatch,
  message?: string,
): existingState is DraftState {
  if (!hasStableDraftType(existingState)) {
    return false;
  }
  if (structuralTypeMatch.routingSource === 'llm-suggested') {
    return false;
  }
  if (structuralTypeMatch.key === 'unknown' && structuralTypeMatch.mappedType === 'unknown') {
    return true;
  }
  return isRetryFeedbackMessage(message) && isConflictingStructuralType(existingState, structuralTypeMatch);
}

function isRetryFeedbackMessage(message: string | undefined): boolean {
  const text = message?.trim();
  if (!text) return false;
  return /^上次尝试失败[:：]/.test(text) || /^Previous attempt failed[:：]/i.test(text);
}

export function resolveRetryTaskMessage(message: string | undefined): string {
  const text = message?.trim();
  if (!text || !isRetryFeedbackMessage(text)) {
    return text || '';
  }
  const split = text.split(/\r?\n\s*\r?\n/);
  if (split.length < 2) {
    return text;
  }
  const taskMessage = split.slice(1).join('\n\n').trim();
  return taskMessage || text;
}

function isConflictingStructuralType(
  existingState: DraftState,
  structuralTypeMatch: StructuralTypeMatch,
): boolean {
  if (structuralTypeMatch.mappedType !== existingState.inferredType) {
    return false;
  }
  const existingKey = existingState.structuralTypeKey ?? existingState.inferredType;
  const nextKey = structuralTypeMatch.key;
  if (!nextKey || nextKey === 'unknown') return false;
  return nextKey !== existingKey;
}

function buildPreservedStructuralTypeMatch(
  state: DraftState,
  plugin: AgentSkillPlugin | null | undefined,
): StructuralTypeMatch {
  return {
    key: state.structuralTypeKey ?? state.inferredType,
    mappedType: state.inferredType,
    skillId: state.skillId ?? plugin?.id,
    supportLevel: state.supportLevel ?? 'supported',
    supportNote: state.supportNote,
    routingSource: 'current-state',
  };
}

export function buildPreservedDraftExtractionResult(args: {
  existingState: DraftState;
  structuralTypeMatch: StructuralTypeMatch;
  plugin?: AgentSkillPlugin | null;
  locale: 'zh' | 'en';
}): {
  responseJson: Record<string, unknown>;
  stateUpdate: Partial<AgentState>;
} {
  const plugin = args.plugin ?? null;
  const mergedState = plugin
    ? plugin.handler.mergeState(args.existingState, {})
    : args.existingState;
  const nextState = { ...mergedState, routingSource: 'current-state' as const, updatedAt: Date.now() };
  const missing = plugin
    ? computeDraftMissing(plugin, nextState, 'execution')
    : { critical: ['skillPlugin'], optional: [] };
  const progress = plugin
    ? buildDraftProgress(args.locale, missing.critical)
    : buildPluginUnavailableProgress(args.locale);
  const clarificationQuestions = plugin
    ? buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, args.locale)
    : [];
  const preservedMatch = buildPreservedStructuralTypeMatch(nextState, plugin);
  const preservationWarning = args.locale === 'zh'
    ? '本轮描述未能稳定识别为新的结构类型，已保留上一版有效草稿，避免将状态覆盖为 unknown/generic。'
    : 'The current message was not recognized as a stable new structural type, so the previous valid draft was preserved instead of being overwritten as unknown/generic.';

  return {
    responseJson: {
      nextState,
      criticalMissing: missing.critical,
      optionalMissing: missing.optional,
      clarificationQuestions,
      structuralTypeMatch: preservedMatch,
      rejectedStructuralTypeMatch: args.structuralTypeMatch,
      skillId: preservedMatch.skillId,
      routingSource: preservedMatch.routingSource,
      extractionMode: 'preserved',
      preservationWarning,
      ...progress,
    },
    stateUpdate: {
      draftState: nextState,
      structuralTypeKey: preservedMatch.key,
    },
  };
}

const ANALYSIS_MESSAGE_LIMIT = 6000;
type TextCompaction = 'middle' | 'tail';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeCheckSkillIdFromResult(codeCheck: unknown): string | undefined {
  if (!isRecord(codeCheck)) return undefined;
  const meta = isRecord(codeCheck.meta) ? codeCheck.meta : {};
  const skillId = typeof meta.codeCheckSkillId === 'string' ? meta.codeCheckSkillId.trim() : '';
  return skillId || undefined;
}

function analysisTraceIdFromResult(analysis: unknown): string | undefined {
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

function hasValidChinaSeismicCodeCheck(codeCheck: unknown, analysis: unknown): boolean {
  if (!isRecord(codeCheck) || codeCheck.skipped === true) return false;
  const analysisTraceId = analysisTraceIdFromResult(analysis);
  const codeCheckAnalysisTraceId = codeCheckAnalysisTraceIdFromResult(codeCheck);
  if (analysisTraceId && codeCheckAnalysisTraceId !== analysisTraceId) {
    return false;
  }
  return codeCheckSkillIdFromResult(codeCheck) === 'code-check-gb50011'
    && hasGlobalSeismicCodeCheckDetail(codeCheck);
}

function analysisWorkflowInputModeFromResult(analysis: unknown): string | undefined {
  if (!isRecord(analysis)) return undefined;
  const data = getAnalysisPayload(analysis);
  return pickStringLike(data, 'workflowInputMode') ?? pickStringLike(analysis, 'workflowInputMode') ?? undefined;
}

function compactText(
  value: unknown,
  limit = ANALYSIS_MESSAGE_LIMIT,
  mode: TextCompaction = 'middle',
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  if (mode === 'tail') {
    const marker = `...[truncated ${omitted} chars]\n`;
    const tailLength = Math.max(0, limit - marker.length);
    return `${marker}${text.slice(-tailLength)}`;
  }
  const marker = `\n...[truncated ${omitted} chars]...\n`;
  const bodyLength = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(bodyLength * 0.35);
  const tailLength = bodyLength - headLength;
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function normalizeAnalysisErrorCode(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return 'ANALYSIS_EXECUTION_FAILED';
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function countRecordEntries(value: unknown): number | undefined {
  return isRecord(value) ? Object.keys(value).length : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function pickNumberLike(record: Record<string, unknown>, key: string): number | string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function pickStringLike(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function omitEmptyRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactFinalCompliance(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return omitEmptyRecord({
    status: pickStringLike(record, 'status'),
    utilization: pickNumberLike(record, 'utilization'),
    driftRatio: pickNumberLike(record, 'driftRatio'),
    limitDriftRatio: pickNumberLike(record, 'limitDriftRatio'),
    source: pickStringLike(record, 'source'),
    scope: pickStringLike(record, 'scope'),
  });
}

function compactCapabilityAssessment(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = optionalRecord(data.capabilityAssessment) ?? data;
  const implementedCapabilities = (
    Array.isArray(source.implementedCapabilities)
      ? source.implementedCapabilities
      : []
  ).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const missingCapabilities = (
    Array.isArray(source.missingCapabilities)
      ? source.missingCapabilities
      : Array.isArray(data.missingCapabilities)
        ? data.missingCapabilities
        : []
  ).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const finalComplianceSupported = typeof source.finalComplianceSupported === 'boolean'
    ? source.finalComplianceSupported
    : undefined;

  return omitEmptyRecord({
    finalComplianceSupported,
    implementedCapabilityCount: implementedCapabilities.length > 0 ? implementedCapabilities.length : undefined,
    implementedCapabilities: implementedCapabilities.length > 0 ? implementedCapabilities.slice(0, 8) : undefined,
    missingCapabilityCount: missingCapabilities.length > 0 ? missingCapabilities.length : undefined,
    missingCapabilities: missingCapabilities.length > 0 ? missingCapabilities.slice(0, 8) : undefined,
  });
}

function compactSpecialSystemReview(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const review = optionalRecord(data.specialSystemReview);
  if (!review) return undefined;
  const systems = Array.isArray(review.systems)
    ? review.systems.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const missingInputs = Array.isArray(review.missingInputs)
    ? review.missingInputs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const capabilityBoundaries = Array.isArray(review.capabilityBoundaries)
    ? review.capabilityBoundaries.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const checks = Array.isArray(review.checks)
    ? review.checks.filter(isRecord)
    : [];
  const isolationEstimate = optionalRecord(review.isolationEquivalentLinearEstimate);
  const isolationFinalCompliance = optionalRecord(isolationEstimate?.finalCompliance);
  const isolationTimeHistoryEstimate = optionalRecord(review.isolationLayerTimeHistoryEstimate);
  const isolationTimeHistoryFinalCompliance = optionalRecord(isolationTimeHistoryEstimate?.finalCompliance);
  const energyEstimate = optionalRecord(review.energyDissipationEquivalentEstimate);
  const energyFinalCompliance = optionalRecord(energyEstimate?.finalCompliance);
  const energyTimeHistoryEstimate = optionalRecord(review.energyDissipationTimeHistoryEstimate);
  const energyTimeHistoryFinalCompliance = optionalRecord(energyTimeHistoryEstimate?.finalCompliance);
  const failedChecks = checks
    .filter((check) => pickStringLike(check, 'status') === 'fail')
    .map((check) => pickStringLike(check, 'item'))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return omitEmptyRecord({
    reviewRequired: typeof review.reviewRequired === 'boolean' ? review.reviewRequired : undefined,
    status: pickStringLike(review, 'status'),
    systems: systems.length > 0 ? systems : undefined,
    missingInputs: missingInputs.length > 0 ? missingInputs.slice(0, 8) : undefined,
    capabilityBoundaries: capabilityBoundaries.length > 0 ? capabilityBoundaries.slice(0, 8) : undefined,
    deviceCounts: optionalRecord(review.deviceCounts),
    checkCount: checks.length > 0 ? checks.length : undefined,
    failedCheckCount: pickNumberLike(review, 'failedCheckCount') ?? (failedChecks.length > 0 ? failedChecks.length : undefined),
    failedChecks: failedChecks.length > 0 ? failedChecks.slice(0, 5) : undefined,
    isolationEquivalentLinearEstimate: isolationEstimate ? omitEmptyRecord({
      status: pickStringLike(isolationEstimate, 'status'),
      periodSec: pickNumberLike(isolationEstimate, 'periodSec'),
      alpha: pickNumberLike(isolationEstimate, 'alpha'),
      baseShearKN: pickNumberLike(isolationEstimate, 'baseShearKN'),
      displacementDemandM: pickNumberLike(isolationEstimate, 'displacementDemandM'),
      displacementCapacityM: pickNumberLike(isolationEstimate, 'displacementCapacityM'),
      displacementUtilization: pickNumberLike(isolationEstimate, 'displacementUtilization'),
      finalCompliance: compactFinalCompliance(isolationFinalCompliance),
    }) : undefined,
    isolationLayerTimeHistoryEstimate: isolationTimeHistoryEstimate ? omitEmptyRecord({
      status: pickStringLike(isolationTimeHistoryEstimate, 'status'),
      periodSec: pickNumberLike(isolationTimeHistoryEstimate, 'periodSec'),
      recordCount: pickNumberLike(isolationTimeHistoryEstimate, 'recordCount'),
      controllingRecord: pickStringLike(isolationTimeHistoryEstimate, 'controllingRecord'),
      maxDisplacementM: pickNumberLike(isolationTimeHistoryEstimate, 'maxDisplacementM'),
      maxBaseShearKN: pickNumberLike(isolationTimeHistoryEstimate, 'maxBaseShearKN'),
      displacementCapacityM: pickNumberLike(isolationTimeHistoryEstimate, 'displacementCapacityM'),
      displacementUtilization: pickNumberLike(isolationTimeHistoryEstimate, 'displacementUtilization'),
      finalCompliance: compactFinalCompliance(isolationTimeHistoryFinalCompliance),
    }) : undefined,
    energyDissipationEquivalentEstimate: energyEstimate ? omitEmptyRecord({
      status: pickStringLike(energyEstimate, 'status'),
      periodSec: pickNumberLike(energyEstimate, 'periodSec'),
      baseDampingRatio: pickNumberLike(energyEstimate, 'baseDampingRatio'),
      additionalDampingRatio: pickNumberLike(energyEstimate, 'additionalDampingRatio'),
      equivalentDampingRatio: pickNumberLike(energyEstimate, 'equivalentDampingRatio'),
      demandReductionRatio: pickNumberLike(energyEstimate, 'demandReductionRatio'),
      adjustedDisplacementDemandM: pickNumberLike(energyEstimate, 'adjustedDisplacementDemandM'),
      deformationCapacityM: pickNumberLike(energyEstimate, 'deformationCapacityM'),
      deformationUtilization: pickNumberLike(energyEstimate, 'deformationUtilization'),
      finalCompliance: compactFinalCompliance(energyFinalCompliance),
    }) : undefined,
    energyDissipationTimeHistoryEstimate: energyTimeHistoryEstimate ? omitEmptyRecord({
      status: pickStringLike(energyTimeHistoryEstimate, 'status'),
      periodSec: pickNumberLike(energyTimeHistoryEstimate, 'periodSec'),
      recordCount: pickNumberLike(energyTimeHistoryEstimate, 'recordCount'),
      controllingRecord: pickStringLike(energyTimeHistoryEstimate, 'controllingRecord'),
      maxDeviceDeformationM: pickNumberLike(energyTimeHistoryEstimate, 'maxDeviceDeformationM'),
      maxDeviceForceKN: pickNumberLike(energyTimeHistoryEstimate, 'maxDeviceForceKN'),
      deformationCapacityM: pickNumberLike(energyTimeHistoryEstimate, 'deformationCapacityM'),
      deformationUtilization: pickNumberLike(energyTimeHistoryEstimate, 'deformationUtilization'),
      forceCapacityKN: pickNumberLike(energyTimeHistoryEstimate, 'forceCapacityKN'),
      forceUtilization: pickNumberLike(energyTimeHistoryEstimate, 'forceUtilization'),
      finalCompliance: compactFinalCompliance(energyTimeHistoryFinalCompliance),
    }) : undefined,
  });
}

function pickAnalysisDiagnostics(
  result: Record<string, unknown>,
  meta: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const diagnostics: Record<string, unknown> = {};
  const copy = (targetKey: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    const isTail = targetKey.endsWith('Tail');
    diagnostics[targetKey] = typeof value === 'string'
      ? compactText(value, 2000, isTail ? 'tail' : 'middle') ?? value
      : value;
  };

  copy('engineId', meta.engineId);
  copy('engineName', meta.engineName);
  copy('failureKind', meta.failureKind);
  copy('capability', meta.capability);
  copy('exceptionType', meta.exceptionType);
  copy('analysisSkillId', meta.analysisSkillId);
  copy('analysisAdapterKey', meta.analysisAdapterKey);
  copy('workDir', meta.workDir);
  copy('runMetaPath', meta.runMetaPath);
  copy('driverResultPath', meta.driverResultPath);
  copy('driverOutputPath', meta.driverOutputPath);
  copy('stdoutPath', meta.stdoutPath);
  copy('stderrPath', meta.stderrPath);
  copy('stdoutTail', meta.stdoutTail);
  copy('stderrTail', meta.stderrTail);
  copy('stepsTail', meta.stepsTail);
  copy('message', result.message);

  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function compactFloorLoadTransferSummary(
  data: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const source = optionalRecord(data.floorLoadTransfer) ?? optionalRecord(result.floorLoadTransfer);
  if (!source) return undefined;

  const rawWarnings = Array.isArray(source.warnings) ? source.warnings : [];
  const warnings = rawWarnings
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 5)
    .map((value) => compactText(value, 500) ?? value);

  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items = rawItems
    .filter(isRecord)
    .slice(0, 8)
    .map((item) => omitEmptyRecord({
      story: pickStringLike(item, 'story'),
      panelId: pickStringLike(item, 'panelId'),
      requestedMode: pickStringLike(item, 'requestedMode'),
      effectiveMode: pickStringLike(item, 'effectiveMode'),
      method: pickStringLike(item, 'method'),
      methodEn: pickStringLike(item, 'methodEn'),
      methodZh: pickStringLike(item, 'methodZh'),
      designCodeRule: pickStringLike(item, 'designCodeRule'),
      designCodeRuleEn: pickStringLike(item, 'designCodeRuleEn'),
      designCodeRuleZh: pickStringLike(item, 'designCodeRuleZh'),
      generatedLoadType: pickStringLike(item, 'generatedLoadType'),
      generatedLoadCount: pickNumberLike(item, 'generatedLoadCount'),
      loadIntensityKNPerM2: pickNumberLike(item, 'loadIntensityKNPerM2'),
      totalLoadKN: pickNumberLike(item, 'totalLoadKN'),
      spanX: pickNumberLike(item, 'spanX'),
      spanY: pickNumberLike(item, 'spanY'),
      longShortRatio: pickNumberLike(item, 'longShortRatio'),
      note: pickStringLike(item, 'note'),
      noteEn: pickStringLike(item, 'noteEn'),
      noteZh: pickStringLike(item, 'noteZh'),
    }))
    .filter((item): item is Record<string, unknown> => !!item);

  return omitEmptyRecord({
    requestedMode: pickStringLike(source, 'requestedMode'),
    effectiveMode: pickStringLike(source, 'effectiveMode'),
    method: pickStringLike(source, 'method'),
    methodEn: pickStringLike(source, 'methodEn'),
    methodZh: pickStringLike(source, 'methodZh'),
    designCode: pickStringLike(source, 'designCode'),
    loadSource: pickStringLike(source, 'loadSource'),
    itemCount: rawItems.length > 0 ? rawItems.length : undefined,
    items: items.length > 0 ? items : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

function compactAnalysisModelContext(
  model: Record<string, unknown> | undefined,
  preferredNodeIds: string[] = [],
  preferredElementIds: string[] = [],
): Record<string, unknown> | undefined {
  if (!model) return undefined;

  const entityLimit = 60;
  const rawNodes = Array.isArray(model.nodes) ? model.nodes : [];
  const rawElements = Array.isArray(model.elements) ? model.elements : [];
  const nodeEntries = rawNodes
    .filter(isRecord)
    .map((node) => {
      const id = pickStringLike(node, 'id');
      if (!id) return null;
      return [id, omitEmptyRecord({
        x: pickNumberLike(node, 'x'),
        y: pickNumberLike(node, 'y'),
        z: pickNumberLike(node, 'z'),
        restraints: Array.isArray(node.restraints)
          ? node.restraints.filter((value): value is boolean => typeof value === 'boolean')
          : undefined,
      }) ?? {}] as const;
    })
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null);
  const elementEntries = rawElements
    .filter(isRecord)
    .map((element) => {
      const id = pickStringLike(element, 'id');
      if (!id) return null;
      return [id, omitEmptyRecord({
        type: pickStringLike(element, 'type'),
        nodes: Array.isArray(element.nodes)
          ? element.nodes
              .map((value) => (
                typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
                  ? String(value)
                  : null
              ))
              .filter((value): value is string => value !== null)
          : undefined,
        material: pickStringLike(element, 'material'),
        section: pickStringLike(element, 'section'),
      }) ?? {}] as const;
    })
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null);

  const prioritizeEntries = (
    entries: Array<readonly [string, Record<string, unknown>]>,
    preferredIds: string[],
  ): Array<readonly [string, Record<string, unknown>]> => {
    const entriesById = new Map(entries);
    const seenIds = new Set<string>();
    const prioritized: Array<readonly [string, Record<string, unknown>]> = [];
    for (const id of [...preferredIds, ...entriesById.keys()]) {
      if (seenIds.has(id)) continue;
      const value = entriesById.get(id);
      if (!value) continue;
      seenIds.add(id);
      prioritized.push([id, value]);
    }
    return prioritized;
  };
  const elementsById = new Map(elementEntries);
  const preferredElementNodeIds = preferredElementIds.flatMap((elementId) => {
    const nodes = elementsById.get(elementId)?.nodes;
    return Array.isArray(nodes)
      ? nodes.filter((nodeId): nodeId is string => typeof nodeId === 'string')
      : [];
  });
  const prioritizedNodeEntries = prioritizeEntries(
    nodeEntries,
    [...preferredElementNodeIds, ...preferredNodeIds],
  );
  const prioritizedElementEntries = prioritizeEntries(elementEntries, preferredElementIds);

  return omitEmptyRecord({
    coordinateSystem: optionalRecord(model.coordinate_system),
    nodes: nodeEntries.length > 0
      ? {
          totalCount: nodeEntries.length,
          truncated: nodeEntries.length > entityLimit,
          values: Object.fromEntries(prioritizedNodeEntries.slice(0, entityLimit)),
        }
      : undefined,
    elements: elementEntries.length > 0
      ? {
          totalCount: elementEntries.length,
          truncated: elementEntries.length > entityLimit,
          values: Object.fromEntries(prioritizedElementEntries.slice(0, entityLimit)),
        }
      : undefined,
  });
}

function buildSuccessfulAnalysisDetails(
  data: Record<string, unknown>,
  result: Record<string, unknown>,
  model?: Record<string, unknown>,
) {
  const summary = optionalRecord(data.summary);
  const envelope = optionalRecord(data.envelope);
  const responseSpectrumFinalCompliance = optionalRecord(data.responseSpectrumFinalCompliance);
  const elasticStoryDriftFinalCompliance = optionalRecord(data.elasticStoryDriftFinalCompliance);
  const elasticPlasticTimeHistory = optionalRecord(data.elasticPlasticTimeHistory);
  const pushover = optionalRecord(data.pushover);
  const caseResults = optionalRecord(data.caseResults);
  const loadCases = optionalRecord(data.loadCases);
  const combinations = optionalRecord(data.combinations);

  const counts = omitEmptyRecord({
    nodeCount: firstDefined(
      summary ? pickNumberLike(summary, 'nodeCount') : undefined,
      countRecordEntries(data.displacements),
    ),
    elementCount: firstDefined(
      summary ? pickNumberLike(summary, 'elementCount') : undefined,
      countRecordEntries(data.forces),
    ),
    reactionNodeCount: firstDefined(
      summary ? pickNumberLike(summary, 'reactionNodeCount') : undefined,
      countRecordEntries(data.reactions),
    ),
    loadCaseCount: firstDefined(
      summary ? pickNumberLike(summary, 'loadCaseCount') : undefined,
      countRecordEntries(caseResults),
      countRecordEntries(loadCases),
    ),
    combinationCount: firstDefined(
      summary ? pickNumberLike(summary, 'combinationCount') : undefined,
      countRecordEntries(combinations),
    ),
  });

  const keyMetrics = envelope ? omitEmptyRecord({
    maxAbsDisplacement: pickNumberLike(envelope, 'maxAbsDisplacement'),
    maxAbsAxialForce: pickNumberLike(envelope, 'maxAbsAxialForce'),
    maxAbsShearForce: pickNumberLike(envelope, 'maxAbsShearForce'),
    maxAbsMoment: pickNumberLike(envelope, 'maxAbsMoment'),
    maxAbsReaction: pickNumberLike(envelope, 'maxAbsReaction'),
    maxBaseShear: pickNumberLike(envelope, 'maxBaseShear'),
    maxStoryDriftRatio: pickNumberLike(envelope, 'maxStoryDriftRatio'),
    modalMassParticipationRatio: pickNumberLike(envelope, 'modalMassParticipationRatio'),
  }) : undefined;

  const controlling = envelope ? omitEmptyRecord({
    controlNodeDisplacement: pickStringLike(envelope, 'controlNodeDisplacement'),
    controlElementAxialForce: pickStringLike(envelope, 'controlElementAxialForce'),
    controlElementShearForce: pickStringLike(envelope, 'controlElementShearForce'),
    controlElementMoment: pickStringLike(envelope, 'controlElementMoment'),
    controlNodeReaction: pickStringLike(envelope, 'controlNodeReaction'),
  }) : undefined;
  const responseEntityLimit = 60;
  const compactResponseEntities = (
    value: unknown,
    preferredIds: Array<string | undefined>,
  ): Record<string, unknown> | undefined => {
    const source = optionalRecord(value);
    if (!source) return undefined;
    const sourceIds = Object.keys(source);
    if (sourceIds.length === 0) return undefined;
    const orderedIds = [
      ...preferredIds.filter((id): id is string => typeof id === 'string' && id in source),
      ...sourceIds,
    ].filter((id, index, allIds) => allIds.indexOf(id) === index);
    const selectedIds = orderedIds.slice(0, responseEntityLimit);
    return {
      totalCount: sourceIds.length,
      truncated: sourceIds.length > selectedIds.length,
      values: Object.fromEntries(selectedIds.map((id) => [id, source[id]])),
    };
  };
  const analysisMeta = optionalRecord(data.meta);
  const responseEnvelopeId = (key: string): string | undefined => (
    envelope ? pickStringLike(envelope, key) ?? undefined : undefined
  );
  const responseMetaValue = (key: string): string | undefined => (
    analysisMeta ? pickStringLike(analysisMeta, key) ?? undefined : undefined
  );
  const preferredModelNodeIds = [
    responseEnvelopeId('controlNodeDisplacement'),
    responseEnvelopeId('controlNodeReaction'),
    ...Object.keys(optionalRecord(data.displacements ?? data.nodeDisplacements) ?? {}),
    ...Object.keys(optionalRecord(data.reactions ?? data.nodeReactions) ?? {}),
  ].filter((id): id is string => typeof id === 'string');
  const preferredModelElementIds = [
    responseEnvelopeId('controlElementAxialForce'),
    responseEnvelopeId('controlElementShearForce'),
    responseEnvelopeId('controlElementMoment'),
  ].filter((id): id is string => typeof id === 'string');
  const responses = omitEmptyRecord({
    coordinateSemantics: responseMetaValue('coordinateSemantics'),
    dimension: responseMetaValue('dimension'),
    plane: responseMetaValue('plane'),
    activeDofs: Array.isArray(analysisMeta?.activeDofs)
      ? analysisMeta.activeDofs.filter((value): value is string => typeof value === 'string')
      : undefined,
    units: optionalRecord(analysisMeta?.units),
    nodalResultFrame: responseMetaValue('nodalResultFrame'),
    elementForceFrame: responseMetaValue('elementForceFrame'),
    displacements: compactResponseEntities(
      data.displacements ?? data.nodeDisplacements,
      [responseEnvelopeId('controlNodeDisplacement')],
    ),
    reactions: compactResponseEntities(
      data.reactions ?? data.nodeReactions,
      [responseEnvelopeId('controlNodeReaction')],
    ),
    memberForces: compactResponseEntities(
      data.forces ?? data.memberForces,
      [
        responseEnvelopeId('controlElementAxialForce'),
        responseEnvelopeId('controlElementShearForce'),
        responseEnvelopeId('controlElementMoment'),
      ],
    ),
  });
  const compliance = omitEmptyRecord({
    responseSpectrumDrift: compactFinalCompliance(responseSpectrumFinalCompliance),
    elasticStoryDrift: compactFinalCompliance(elasticStoryDriftFinalCompliance),
    elasticPlasticTimeHistory: compactFinalCompliance(optionalRecord(elasticPlasticTimeHistory?.finalCompliance)),
    pushover: compactFinalCompliance(optionalRecord(pushover?.finalCompliance)),
  });

  const rawWarnings = Array.isArray(data.warnings)
    ? data.warnings
    : Array.isArray(result.warnings)
      ? result.warnings
      : [];
  const warnings = rawWarnings
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 5)
    .map((value) => compactText(value, 500) ?? value);

  return omitEmptyRecord({
    workflowInputMode: pickStringLike(data, 'workflowInputMode') ?? pickStringLike(result, 'workflowInputMode'),
    counts,
    keyMetrics,
    controlling,
    modelContext: compactAnalysisModelContext(
      model,
      preferredModelNodeIds,
      preferredModelElementIds,
    ),
    responses,
    compliance,
    capabilityAssessment: compactCapabilityAssessment(data),
    specialSystemReview: compactSpecialSystemReview(data),
    floorLoadTransfer: compactFloorLoadTransferSummary(data, result),
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}

function getAnalysisPayload(result: Record<string, unknown>): Record<string, unknown> {
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
    return {
      success: false,
      skillId: args.skillId,
      errorCode,
      message: compactText(result.message ?? data.message)
        || (invalidResult
          ? 'Analysis returned no explicit success or failure status'
          : 'Analysis execution failed'),
      ...(diagnostics ? { diagnostics } : {}),
    };
  }

  return {
    success: true,
    skillId: args.skillId,
    ...(result.runId ? { runId: result.runId, resultKeys: isRecord(result.results) ? Object.keys(result.results) : [], selectedResultKey: result.selectedResultKey,
      executionStatus: result.executionStatus, capabilityStatus: result.capabilityStatus } : {}),
    analysisMode: data?.analysisMode,
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

  return {
    success: true,
    nodeCount,
    elementCount,
    schemaVersion,
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
      ...invalidateAnalysis(state),
      model: state?.model ?? null,
      modelPending: true,
    };
  }
  return commitModel(state, model, 'build_model');
}

async function resolveExistingDraftPlugin(
  skillRuntime: AgentSkillRuntime,
  existingState: DraftState,
  skillIds: string[] | undefined,
  fallbackPlugin: AgentSkillPlugin | null,
): Promise<AgentSkillPlugin | null> {
  const pluginBySkill = existingState.skillId
    ? await skillRuntime.resolvePluginForType(existingState.skillId, skillIds)
    : null;
  if (pluginBySkill) {
    return pluginBySkill;
  }

  const pluginByType = await skillRuntime.resolvePluginForType(existingState.inferredType, skillIds);
  if (pluginByType) {
    return pluginByType;
  }

  return fallbackPlugin?.id === 'generic' ? fallbackPlugin : null;
}

// ---------------------------------------------------------------------------
// Engineering tools (wrap AgentSkillRuntime)
// ---------------------------------------------------------------------------

function detectStructuralTypeWithConfiguredLlm(
  skillRuntime: AgentSkillRuntime,
  args: {
    message: string;
    locale: 'zh' | 'en';
    currentState?: DraftState;
    skillIds?: string[];
    signal?: AbortSignal;
    onUsage?: (usage: LlmTokenUsage) => void;
  },
): Promise<StructuralTypeMatch> {
  const routerLlm = createChatModel(0, { disableStreaming: true });
  return skillRuntime.detectStructuralTypeWithLlm(
    routerLlm,
    args.message,
    args.locale,
    args.currentState,
    args.skillIds,
    args.signal,
    args.onUsage,
  );
}

export async function resolveDetectedStructuralTypeMatch(
  skillRuntime: Pick<AgentSkillRuntime, 'resolvePluginForType'>,
  structuralTypeKey: string | null | undefined,
  skillIds?: string[],
): Promise<StructuralTypeMatch | null> {
  if (!structuralTypeKey) return null;
  const plugin = await skillRuntime.resolvePluginForType(structuralTypeKey, skillIds);
  if (!plugin) return null;
  return {
    key: structuralTypeKey as StructuralTypeKey,
    mappedType: plugin.structureType,
    skillId: plugin.id,
    supportLevel: 'supported',
    routingSource: 'current-state',
  };
}

export function createDetectStructureTypeTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: { message?: string; locale?: string }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const skillIds = configurable.skillScope;
        const locale = (input.locale ?? state?.locale ?? 'zh') as 'en' | 'zh';
      const message = resolveToolInputMessage(input.message, state?.lastUserMessage, state?.messages);
      const detectionMessage = resolveRetryTaskMessage(message);
      const nestedUsage = nestedLlmUsageCollector();
      try {
        const match = await detectStructuralTypeWithConfiguredLlm(skillRuntime, {
          message: detectionMessage,
          locale,
          currentState: state?.draftState || undefined,
          skillIds,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
        });
        const unsupported = match.supportLevel === 'unsupported';
        const result = {
          key: match.key,
          mappedType: match.mappedType,
          skillId: match.skillId,
          routingSource: match.routingSource,
          supportLevel: match.supportLevel,
          supportNote: match.supportNote,
          nextAction: unsupported ? 'explain_capability_boundary' : 'extract_draft_params',
          instruction: unsupported
            ? (locale === 'zh'
              ? '当前技能或适配器不支持该请求。不得继续提取参数、构建模型或运行分析；请明确说明具体能力边界，并询问用户是否改用当前明确支持的替代工作流。'
              : 'The current skills or adapters do not support this request. Do not extract parameters, build a model, or run analysis. Explain the specific capability boundary and ask whether the user wants a currently supported alternative workflow.')
            : (locale === 'zh'
              ? '结构类型已识别。若用户请求建模、分析或报告，下一步调用 extract_draft_params；不要只输出结构类型后停止。'
              : 'Structural type detected. If the user requested modeling, analysis, or reporting, call extract_draft_params next; do not stop after reporting the type.'),
        };
        const stateUpdate: Partial<AgentState> = {};
        if (match.key) stateUpdate.structuralTypeKey = match.key;
        logToolCall(log, { tool: 'detect_structure_type', durationMs: Date.now() - start, extra: { matchedKey: match.key, skillId: match.skillId, routingSource: match.routingSource } });
        return toolResult(
          toolCallId,
          'detect_structure_type',
          JSON.stringify(result),
          stateUpdate,
          nestedUsage.total(),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'detect_structure_type', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        if (
          errorMessage.startsWith('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:')
        ) {
          return toolResult(
            toolCallId,
            'detect_structure_type',
            JSON.stringify({
              success: false,
              errorCode: 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT',
              message: errorMessage,
              nextAction: 'retry_detection',
            }),
            undefined,
            nestedUsage.total(),
          );
        }
        throw error;
      }
    },
    {
      name: 'detect_structure_type',
      description:
        'Detect the structural type (beam, truss, frame, portal-frame, etc.) from a user description. ' +
        'Returns the matched type key, mapped model type, and the skill ID to use for further processing.',
      schema: z.object({
        message: z.string().describe('The user message describing the structure').optional(),
        locale: z.enum(['zh', 'en']).optional().describe('User locale (defaults to session locale)'),
      }),
    },
  );
}

export function createExtractDraftParamsTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      message?: string;
      locale?: string;
      requestScope?: RequestScope;
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      const requestedScope = input.requestScope ?? state?.requestScope;
      const existingState = state?.draftState ? { ...state.draftState, ...(requestedScope ? { requestScope: requestedScope } : {}) } : undefined;
      const skillIds = configurable.skillScope;
      const locale = (input.locale ?? state?.locale ?? 'zh') as 'zh' | 'en';
      const message = resolveToolInputMessage(input.message, state?.lastUserMessage, state?.messages);
      const extractionMessage = resolveRetryTaskMessage(message);
      const nestedUsage = nestedLlmUsageCollector();
      const extractionToolResult = (
        content: string,
        stateUpdate?: Partial<AgentState>,
      ): Command => toolResult(
        toolCallId,
        'extract_draft_params',
        content,
        { ...stateUpdate, ...(stateUpdate?.requestScope || requestedScope ? { requestScope: stateUpdate?.requestScope ?? requestedScope } : {}),
          ...(stateUpdate?.draftState ? { draftState: { ...stateUpdate.draftState,
            ...(stateUpdate.requestScope || requestedScope ? { requestScope: stateUpdate.requestScope ?? requestedScope } : {}) } } : {}) },
        nestedUsage.total(),
      );

      try {
        // Step 1: Detect structural type
        log.debug({
          hasLastUserMessage: !!state?.lastUserMessage,
          messageCount: Array.isArray(state?.messages) ? state.messages.length : 0,
          inputMessagePreview: input.message?.slice(0, 120),
          resolvedMessagePreview: message.slice(0, 120),
          extractionMessagePreview: extractionMessage.slice(0, 120),
        }, 'extract_draft_params resolved message');
        const detectedMatch = currentRunPolicy()?.routing.mode === 'fixed' ? null : await resolveDetectedStructuralTypeMatch(
          skillRuntime,
          state?.structuralTypeKey,
          skillIds,
        );
        const match = detectedMatch ?? await detectStructuralTypeWithConfiguredLlm(skillRuntime, {
          message: extractionMessage,
          locale,
          currentState: existingState,
          skillIds,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
        });
        const matchedPlugin = match.skillId
          ? await skillRuntime.resolvePluginForType(match.skillId, skillIds)
          : null;
        log.debug({
          detectedKey: match.key,
          detectedSkillId: match.skillId,
          routingSource: match.routingSource,
          reusedDetection: detectedMatch !== null,
          matchedPluginId: matchedPlugin?.id,
        }, 'extract_draft_params structural match');

        if (shouldPreserveExistingDraftState(existingState, match, message)) {
          const preservationPlugin = await resolveExistingDraftPlugin(
            skillRuntime,
            existingState,
            skillIds,
            matchedPlugin,
          );
          const preserved = buildPreservedDraftExtractionResult({
            existingState,
            structuralTypeMatch: match,
            plugin: preservationPlugin,
            locale,
          });
          logToolCall(log, {
            tool: 'extract_draft_params',
            durationMs: Date.now() - start,
            extra: {
              preservedExistingDraft: true,
              previousSkillId: existingState.skillId,
              rejectedSkillId: match.skillId,
              rejectedKey: match.key,
              rejectedRoutingSource: match.routingSource,
            },
          });
          return extractionToolResult(
            JSON.stringify(preserved.responseJson),
            preserved.stateUpdate,
          );
        }

        // Early return when no skill matched
        if (!match.skillId) {
          const nextState = {
            ...(existingState || { inferredType: 'unknown' as const }),
            structuralTypeKey: match.key,
            supportLevel: match.supportLevel,
            supportNote: match.supportNote,
            routingSource: match.routingSource,
            updatedAt: Date.now(),
          };
          const responseJson = {
            nextState,
            criticalMissing: ['inferredType'],
            optionalMissing: [],
            clarificationQuestions: [],
            structuralTypeMatch: match,
            skillId: undefined,
            routingSource: match.routingSource,
            extractionMode: 'not-applicable',
            ...buildDraftProgress(locale, ['inferredType']),
          };
          const stateUpdate: Partial<AgentState> = { draftState: nextState };
          if (match.key) stateUpdate.structuralTypeKey = match.key;
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: undefined, criticalMissing: 1, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
        }

        // Step 2: Resolve plugin
        const plugin = matchedPlugin;
        if (!plugin) {
          const nextState: DraftState = existingState == null
            ? { inferredType: 'unknown' as const, routingSource: match.routingSource, updatedAt: Date.now() }
            : { ...(existingState as DraftState), routingSource: match.routingSource, updatedAt: Date.now() };
          const responseJson = {
            nextState,
            criticalMissing: ['inferredType'],
            optionalMissing: [],
            clarificationQuestions: [],
            structuralTypeMatch: match,
            skillId: undefined,
            routingSource: match.routingSource,
            extractionMode: 'unavailable',
            ...buildDraftProgress(locale, ['inferredType']),
          };
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: match.skillId, pluginResolved: false, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), { draftState: nextState });
        }

        // Generic skill: deterministic path (no LLM extraction needed)
        const stableExistingState = hasStableDraftType(existingState) ? existingState : undefined;
        if (
          plugin.id === 'generic'
          && stableExistingState
        ) {
          const { withStructuralTypeState } = await import('../agent-runtime/plugin-helpers.js');
          const resetToGeneric = isFreshGenericStructuralRoute(match);
          const nextState = withStructuralTypeState(
            plugin.handler.mergeState(resetToGeneric ? undefined : stableExistingState, resetToGeneric ? { inferredType: 'unknown' } : {}),
            match,
          );
          const missing = computeDraftMissing(plugin, nextState, 'execution');
          const responseJson = {
            nextState,
            criticalMissing: missing.critical,
            optionalMissing: missing.optional,
            clarificationQuestions: buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, locale),
            structuralTypeMatch: match,
            skillId: plugin.id,
            routingSource: match.routingSource,
            extractionMode: 'deterministic',
            ...buildDraftProgress(locale, missing.critical),
          };
          const stateUpdate: Partial<AgentState> = { ...(resetToGeneric ? { ...invalidateAnalysis(state), modelPending: true } : {}),
            draftState: nextState, structuralTypeKey: match.key };
          logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: 'deterministic', criticalMissing: missing.critical.length, routingSource: match.routingSource } });
          return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
        }

        // Step 3: Sub-agent extracts parameters (skill manifest driven)
        const { invokeParamExtractor } = await import('./param-extractor.js');
        const draftPatch = await invokeParamExtractor({
          message: extractionMessage,
          existingState,
          locale,
          plugin,
          traceLogger: log,
          signal: config.signal,
          onUsage: nestedUsage.onUsage,
        });

        // Step 4: Handler pipeline (extractDraft → mergeState → computeMissing)
        const patch = plugin.handler.extractDraft({
          message: extractionMessage,
          locale,
          currentState: existingState,
          llmDraftPatch: draftPatch,
          structuralTypeMatch: match,
        });
        const { withStructuralTypeState } = await import('../agent-runtime/plugin-helpers.js');
        const scopeDiagnostics: ScopeDiagnostic[] = [];
        const requestScope = resolveExtractedScope(input.requestScope, draftPatch?.requestScope, state?.requestScope, scopeDiagnostics);
        if (scopeDiagnostics.length) recordRunEvent({ kind: 'request_scope_diagnostic', source: 'parameter-extractor', diagnostics: scopeDiagnostics,
          resolvedBy: input.requestScope ? 'declared-request' : state?.requestScope ? 'accepted-request' : 'clarification' });
        const nextState = { ...withStructuralTypeState(plugin.handler.mergeState(existingState, patch), match),
          ...(requestScope ? { requestScope } : {}) };
        const goalRequired = scopeDiagnostics.some(issue => issue.code === 'REQUEST_GOAL_REQUIRED');
        const missing = goalRequired ? { critical: ['requestScope'], optional: [] } : computeDraftMissing(plugin, nextState, 'execution');
        const extractionMode = draftPatch ? 'llm' : 'deterministic';
        let equilibriumContext = requestScope?.method === 'equilibrium' && !missing.critical.length
          ? equilibriumModel(nextState) : undefined;
        let partialEquilibriumAvailable = false;
        if (requestScope?.method === 'solver' && !requestScope.design && missing.critical.length
          && requestScope.responses.some(field => ['forces', 'reactions'].includes(field))) {
          try { equilibriumContext = equilibriumModel(nextState); partialEquilibriumAvailable = true; } catch { /* Full-model missing conditions remain authoritative. */ }
        }

        // Missing engineering input is a clarification state, not a failed extraction.
        // Repeating the same evidence cannot supply user-omitted properties and must
        // not consume the semantic recovery budget. Invalid LLM output is handled
        // separately inside invokeParamExtractor.

        const responseJson = {
          nextState,
          criticalMissing: missing.critical,
          optionalMissing: missing.optional,
          clarificationQuestions: goalRequired ? [{ paramKey: 'requestScope', label: locale === 'zh' ? '所求结果' : 'Requested results',
            question: locale === 'zh' ? '你需要内力/反力、位移/挠度，还是还需要规范设计或报告？已提供的梁跨度与荷载会保留。'
              : 'Do you need forces/reactions, displacement/deflection, or also code design or a report? The supplied span and loads are retained.',
            required: true, critical: true }] : buildClarificationQuestions(plugin, missing.critical, missing.optional, nextState, locale),
          structuralTypeMatch: match,
          skillId: plugin.id,
          routingSource: match.routingSource,
          extractionMode,
          requestScope,
          ...(scopeDiagnostics.length ? { scopeDiagnostics } : {}),
          ...(partialEquilibriumAvailable ? { partialAnalysisAvailable: { method: 'equilibrium', allowPartial: true,
            availableResponses: ['forces', 'reactions'], missingForFullAnalysis: missing.critical,
            instruction: 'First run_analysis(method=equilibrium,allowPartial=true) for independently determined forces. Then ask for stiffness for displacement; the task remains partial. / 先计算可独立确定的内力，再询问位移所需刚度；不能宣布整题完成。' } } : {}),
          ...(equilibriumContext ? { calculationContext: { nodes: equilibriumContext.nodes, elements: equilibriumContext.elements,
            resultKeys: (equilibriumContext.load_cases as Record<string, unknown>[]).map(c => `case:${c.id}`),
            verticalBendingMomentComponent: 'M2', verticalShearComponent: 'V3', verticalReactionComponent: 'fz',
            note: 'Use these exact IDs and components. resultKey is the load case, not a label for a requested output. / 使用这些实际ID与分量；resultKey是工况键，不是所求结果名称。' } } : {}),
          missingReasons: missing.critical.map(field => ({ field, reason: missingInputReason(field, requestScope, locale) })),
          llmDraftPatch: draftPatch ?? null,
          engineeringDraft: nextState.engineeringDraft ?? patch.engineeringDraft ?? null,
          extractionSource: typeof nextState.skillState?.extractionSource === 'string'
            ? nextState.skillState.extractionSource
            : (draftPatch ? 'llm-draft-patch' : 'deterministic'),
          ...buildDraftProgress(locale, missing.critical),
          ...(partialEquilibriumAvailable ? { nextAction: 'run_analysis', canAnalyzePartial: true,
            instruction: locale === 'zh' ? '完整分析仍缺属性；先run_analysis(method=equilibrium,allowPartial=true)计算独立内力，再澄清位移所需刚度。不要build_model或编造材料截面。'
              : 'Full analysis lacks properties. First run_analysis(method=equilibrium,allowPartial=true) for independent forces, then clarify stiffness. Do not build_model or invent material/section.' } : {}),
          ...(requestScope?.method === 'equilibrium' && missing.critical.length === 0 ? {
            nextAction: 'run_analysis', instruction: locale === 'zh'
              ? '直接调用run_analysis(method=equilibrium)。仅计算内力和反力，不需要材料截面，不生成未请求的变形、规范校核或报告。'
              : 'Call run_analysis(method=equilibrium) directly. Forces/reactions only; no material/section, unrequested deformation, code checking or report.' } : {}),
        };

        const stateUpdate: Partial<AgentState> = {};
        if (requestScope) stateUpdate.requestScope = requestScope;
        if (nextState) {
          Object.assign(stateUpdate, invalidateAnalysis(state));
          stateUpdate.draftState = nextState;
          stateUpdate.modelPending = true;
        }
        if (match.key) stateUpdate.structuralTypeKey = match.key;

        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, extra: { skillId: plugin.id, extractionMode: responseJson.extractionMode, criticalMissing: missing.critical.length, routingSource: match.routingSource } });
        return extractionToolResult(JSON.stringify(responseJson), stateUpdate);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logToolCall(log, { tool: 'extract_draft_params', durationMs: Date.now() - start, success: false, extra: { error: errorMessage } });
        if (
          (
            errorMessage.startsWith('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:')
            || errorMessage.startsWith('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT:')
          )
        ) {
          const errorCode = errorMessage.startsWith('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT:')
            ? 'LLM_PARAM_EXTRACTOR_INVALID_OUTPUT'
            : 'LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT';
          return extractionToolResult(JSON.stringify({
            success: false,
            errorCode,
            message: errorMessage,
            nextAction: 'retry_extraction',
          }));
        }
        throw error;
      }
    },
    {
      name: 'extract_draft_params',
      description:
        'Extract structural engineering parameters from a user message and merge them into the draft state. ' +
        'Reads existing draft state from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns updated draft state, missing fields, and the matched structural type.',
      schema: z.object({
        message: z.string().describe('The user message to extract parameters from').optional(),
        locale: z.enum(['zh', 'en']).optional().describe('User locale'),
        requestScope: requestScopeSchema.optional().describe('Current user goal, not the full engineering workflow. Use equilibrium only for an explicitly force-only, horizontal single-span simply-supported/left-fixed cantilever beam, without a specified engine. Preserve scope while receiving missing-input answers. / 本次用户所求结果；单跨简支或左固悬臂仅求内力且未指定引擎时可用equilibrium。补参数时保留范围。'),
      }),
    },
  );
}

export function createBuildModelTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (_input: Record<string, unknown>, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      // Read draft state from graph state channel
      const draftState = state?.draftState;
      if (!draftState) {
        throw new Error('No draft state available. Run extract_draft_params first.');
      }
      const skillIds = configurable.skillScope;

      const candidate = await skillRuntime.buildModel(draftState, skillIds, {
        message: state?.lastUserMessage || '',
        locale: state?.locale || 'zh',
        currentModel: state?.model ?? undefined,
        conversationHistory: state?.messages.map((message) => `${messageRole(message)}: ${messageText(message)}`).join('\n'),
      });
      if (!candidate) {
        logToolCall(log, { tool: 'build_model', durationMs: Date.now() - start, extra: { success: false } });
        throw new Error('Model build returned undefined — draft may be incomplete. Try running extract_draft_params again with more explicit parameters.');
      }
      const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
      const model = await normalizeEngineeringModel({ ...candidate, metadata: { ...metadata,
        inputEvidence: mergeInputEvidence(state?.inputEvidence, Array.isArray(metadata.inputEvidence) ? metadata.inputEvidence.filter(isRecord) : []) } }, configurable.structureProtocolClient);

      // Store model in graph state via Command.
      // Keep ToolMessage content compact — full model lives in graph state.
      // The streaming layer reads model from nodeState for artifact_payload_sync.
      const summary = buildModelToolSummary(model, state?.locale || 'zh');
      const success = summary.success !== false;
      logToolCall(log, { tool: 'build_model', durationMs: Date.now() - start, success, extra: summary });
      return toolResult(
        toolCallId,
        'build_model',
        JSON.stringify(summary),
        buildModelToolStateUpdate(model, summary, state),
      );
    },
    {
      name: 'build_model',
      description:
        'Build a computable structural model from the current draft state. ' +
        'Reads draft state from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns the model if all critical parameters are present, or an error if the draft is incomplete.',
      schema: z.object({}),
    },
  );
}

export function createAskUserClarificationTool() {
  return tool(
    async (input: { question: string; optionsJson?: string }) => {
      const options = input.optionsJson === undefined ? undefined : normalizeClarificationOptions(input.optionsJson);
      if (input.optionsJson && !options?.length) recordRunEvent({ kind: 'clarification_options_ignored', reason: 'OPTIONAL_CHOICES_UNAVAILABLE' });

      if (currentRunPolicy()?.executionOwner === 'external') {
        return JSON.stringify({ type: 'clarification_needed', question: input.question, options,
          nextAction: 'await_user_input', resume: 'Begin a new user turn with the actual user answer; the external host owns dialogue.' });
      }

      const userResponse = interrupt({
        type: 'clarification_needed',
        question: input.question,
        options,
      }) as string;

      return JSON.stringify({
        type: 'clarification_answered',
        question: input.question,
        answer: userResponse,
        nextAction: 'extract_draft_params',
        instruction: 'Clarification answers are not merged into draftState automatically. Call extract_draft_params with this exact answer before build_model.',
      });
    },
    {
      name: 'ask_user_clarification',
      description:
        'Pause execution and ask the user a clarification question. ' +
        'Use this when you cannot proceed without user input. ' +
        'The graph will resume once the user provides an answer.',
      schema: z.object({
        question: z.string().trim().min(1).describe('The question to ask the user'),
        optionsJson: z
          .string()
          .optional()
          .describe('JSON array of suggested answer strings; each string must contain the complete answer to send when selected'),
      }),
    },
  );
}

export function createSetSessionConfigTool() {
  return tool(
    async (input: {
      analysisType?: string;
      designCode?: string;
      skillIdsJson?: string;
    }, config: LangGraphRunnableConfig) => {
      const state = getConfigurable(config).agentState;
      const toolCallId = getToolCallId(config);

      const updatedKeys: string[] = [];
      const stateUpdate: Partial<AgentState> = {};
      const existingSkillIds = Array.isArray(state?.selectedSkillIds)
        ? state.selectedSkillIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      let nextSkillIds: string[] | undefined;

      if (input.analysisType) {
        stateUpdate.policy = {
          ...(state?.policy || {}),
          analysisType: input.analysisType as 'static' | 'dynamic' | 'seismic' | 'nonlinear',
        };
        updatedKeys.push('analysisType');
      }
      if (input.designCode) {
        stateUpdate.policy = {
          ...(state?.policy || {}),
          ...(stateUpdate.policy || {}),
          designCode: input.designCode,
        };
        updatedKeys.push('designCode');
      }
      if (input.skillIdsJson) {
        const parsedSkillIds = parseSkillIdsJson(input.skillIdsJson);
        if (!parsedSkillIds.ok) {
          return toolResult(toolCallId, 'set_session_config', JSON.stringify({
            success: false,
            error_code: 'INVALID_SKILL_IDS_JSON',
            message: parsedSkillIds.error,
          }));
        }
        nextSkillIds = parsedSkillIds.value;
      }

      const nextAnalysisType = stateUpdate.policy?.analysisType ?? state?.policy?.analysisType;
      const nextDesignCode = stateUpdate.policy?.designCode ?? state?.policy?.designCode;
      const skillIdsForDecision = nextSkillIds ?? existingSkillIds;
      if (nextSkillIds !== undefined) {
        stateUpdate.selectedSkillIds = isChinaSeismicSessionConfig({
          analysisType: nextAnalysisType,
          designCode: nextDesignCode,
          skillIds: nextSkillIds,
        })
          ? completeChinaSeismicSkillIds(nextSkillIds)
          : uniqueStrings(nextSkillIds);
        updatedKeys.push('selectedSkillIds');
      } else if (isChinaSeismicSessionConfig({
        analysisType: nextAnalysisType,
        designCode: nextDesignCode,
        skillIds: skillIdsForDecision,
      })) {
        stateUpdate.selectedSkillIds = completeChinaSeismicSkillIds(skillIdsForDecision);
        updatedKeys.push('selectedSkillIds');
      }

      const runPolicy = currentRunPolicy() ?? state?.runPolicy;
      if (runPolicy && stateUpdate.selectedSkillIds) {
        const outside = stateUpdate.selectedSkillIds.filter(id => !runPolicy.activeSkillIds.includes(id));
        const fixed = runPolicy.routing.mode === 'fixed' ? runPolicy.routing.skillId : undefined;
        if (outside.length || fixed && !stateUpdate.selectedSkillIds.includes(fixed)) {
          return toolResult(toolCallId, 'set_session_config', JSON.stringify({ success: false,
            error_code: 'SKILL_SCOPE_IMMUTABLE', deniedSkillIds: outside,
            message: 'Session selection cannot widen the run scope or remove its fixed modeling provider.' }));
        }
      }

      const responseJson = {
        success: true,
        updatedKeys,
        message: `Updated: ${updatedKeys.join(', ') || 'nothing'}`,
      };

      // Only return Command if there are actual updates
      if (updatedKeys.length > 0) {
        if (input.analysisType && input.analysisType !== state?.policy?.analysisType || input.skillIdsJson) {
          Object.assign(stateUpdate, invalidateAnalysis(state));
        } else if (input.designCode && input.designCode !== state?.policy?.designCode) {
          stateUpdate.codeCheckResult = null;
          stateUpdate.report = null;
        }
        return toolResult(toolCallId, 'set_session_config', JSON.stringify(responseJson), stateUpdate);
      }
      return JSON.stringify(responseJson);
    },
    {
      name: 'set_session_config',
      description:
        'Update current-session configuration: analysis type (static/dynamic/seismic/nonlinear), ' +
        'design code (GB50010/GB50011/GB50017), or selected skill IDs. ' +
        'For China seismic analysis, set analysisType to seismic; the tool will keep the workflow-safe baseline skills for modeling, OpenSees seismic analysis, GB50011 code-check, validation, and reporting. ' +
        'This does not create persistent memory.',
      schema: z.object({
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .optional()
          .describe('Analysis type to set'),
        designCode: z
          .string()
          .optional()
          .describe('Design code to set (e.g. GB50017, GB/T 50011-2010-2024)'),
        skillIdsJson: z
          .string()
          .optional()
          .describe('JSON array of skill IDs to select. For China seismic workflows, opensees-seismic or GB50011 selection is auto-completed with the required modeling, code-check, validation, and report baseline skills.'),
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Engineering execution tools (wrap AgentSkillRuntime execution methods)
// ---------------------------------------------------------------------------

export function createValidateModelTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: { engineId?: string }, config: LangGraphRunnableConfig) => {
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      // Read model from graph state channel
      const model = state?.model;
      if (!model) {
        return JSON.stringify({ error: 'No model available. Run build_model first.' });
      }
      assertInputEvidenceMatchesModel(model, state?.inputEvidence);
      const skillIds = configurable.skillScope;
      const analysisType = normalizeAnalysisType(state?.policy?.analysisType);
      const unselectedRequestedSkillId = resolveUnselectedRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
      );
      if (unselectedRequestedSkillId) {
        return JSON.stringify(buildAnalysisProviderNotSelectedPayload(unselectedRequestedSkillId));
      }
      const requestedEngineId = resolveRequestedAnalysisEngineId(state?.lastUserMessage, skillIds, analysisType);
      const result = await skillRuntime.executeValidationSkill({
        model,
        engineId: input.engineId || requestedEngineId,
        structureProtocolClient: configurable.structureProtocolClient,
      });
      // Keep output compact — trim large model echo from validation result
      const compact: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
        if (k === 'input') {
          compact[k] = { model: '(model stored in state)' };
        } else {
          compact[k] = v;
        }
      }
      return JSON.stringify(compact);
    },
    {
      name: 'validate_model',
      description:
        'Validate the current structural model for correctness (connectivity, geometry, loads). ' +
        'Reads the model from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns validation errors and warnings.',
      schema: z.object({
        engineId: z.string().optional().describe('Optional analysis engine ID'),
      }),
    },
  );
}

export function createRunAnalysisTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      analysisType: string;
      analysisSkillId?: string;
      loadCombinationId?: string;
      loadCaseIds?: string[];
      loadCombinationIds?: string[];
      floorLoadTransferMode?: 'auto_code_cn' | 'node_tributary' | 'one_way_slab' | 'two_way_slab';
      seismicWorkflowJson?: string;
      method?: 'modal' | 'time_history' | 'equilibrium';
      allowPartial?: boolean;
      requestScope?: RequestScope;
      massSource?: 'nodal' | 'member-density' | 'floor-seismic';
      numModes?: number;
      direction?: 'x' | 'y' | 'z';
      timeStep?: number;
      duration?: number;
      dampingRatio?: number;
      groundMotion?: number[];
      groundMotionUnit?: 'm/s2' | 'g';
      monitorNodeIds?: string[];
      monitorElementIds?: string[];
      monitorSupportNodeIds?: string[];
      massDirections?: ('x' | 'y' | 'z')[];
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);

      const equilibriumRequested = input.method !== undefined ? input.method === 'equilibrium'
        : input.requestScope !== undefined ? input.requestScope.method === 'equilibrium'
          : !input.analysisSkillId && state?.requestScope?.method === 'equilibrium';
      // A tool may select only available responses, but cannot erase the accepted goal.
      const partialGoal = equilibriumRequested && state?.requestScope?.responses.some(field => !['forces', 'reactions'].includes(field))
        ? state.requestScope : undefined;
      const goal = partialGoal
        ? { ...partialGoal, outputs: input.requestScope?.outputs.length ? input.requestScope.outputs : partialGoal.outputs }
        : input.requestScope ?? state?.requestScope;
      const scope = !equilibriumRequested && goal?.method === 'equilibrium' ? { ...goal, method: 'solver' as const } : goal;
      if (equilibriumRequested) {
        const partial = (input.allowPartial === true || !!partialGoal) && scope && !scope.design
          && scope.responses.some(field => !['forces', 'reactions'].includes(field))
          && !scope.responses.includes('dynamic') && scope.responses.some(field => ['forces', 'reactions'].includes(field));
        if (input.analysisType !== 'static' || !forceOnlyScope(scope) && !partial) throw new Error('EQUILIBRIUM_FORCE_ONLY_REQUIRED / 平衡计算仅适用于静力内力或反力');
        if (input.analysisSkillId || state?.model && !state.modelPending) throw new Error('EQUILIBRIUM_NOT_A_SOLVER_FALLBACK / 指定引擎或已有完整模型必须使用真实求解路径');
        if (!state?.draftState) throw new Error('ENGINEERING_DRAFT_REQUIRED');
        const projection = equilibriumModel(state.draftState, state.inputEvidence);
        const parameters = { ...(input.loadCaseIds ? { loadCaseIds: input.loadCaseIds } : {}),
          ...(input.loadCombinationIds ? { loadCombinationIds: input.loadCombinationIds } : {}),
          ...(input.loadCombinationId ? { loadCombinationId: input.loadCombinationId } : {}) };
        const reservation = beginAnalysisRequest(state, analysisSettingsHash('static', 'builtin-equilibrium', parameters), projection);
        configurable.agentState = { ...state, ...reservation };
        configurable.onAnalysisRequest?.(reservation);
        const requestId = randomUUID();
        recordRunEvent({ kind: 'analysis_request', requestId, operation: 'analysis', method: 'equilibrium' });
        const { data: run } = await configurable.engineClient.post<Record<string, unknown>>('/analyze', {
          type: 'static', engineId: 'builtin-equilibrium', model: projection, parameters, requestScope: scope,
          requestId, requestBinding: reservation.analysisRequest }, { signal: config.signal });
        run.meta = { ...(isRecord(run.meta) ? run.meta : {}), requestScope: scope };
        const update = publishAnalysis(getConfigurable(config).agentState ?? {}, reservation.analysisRequest, run);
        const delivery = update.analysisResult ? await queryRequestedOutputs({ ...state, ...reservation, ...update }, scope, config) : undefined;
        return toolResult(toolCallId, 'run_analysis', JSON.stringify({ ...buildAnalysisToolSummary({ result: run, model: projection }),
          method: 'equilibrium', availableResponses: ['forces', 'reactions'], requestScope: scope,
          ...(partial ? { deliveryStatus: 'partial', missingRequestedResponses: scope.responses.filter(field => !['forces', 'reactions'].includes(field)),
            nextAction: 'ask_user_clarification', message: 'Forces solved; displacement/other requested responses still need analysis properties. / 内力已算；位移等其余所求量仍需分析属性。' } : {}),
          ...(delivery ? { requestedQuantities: delivery.requestedQuantities, missingRequestedOutputs: delivery.missingRequestedOutputs } : {}),
          instruction: 'Query forces/reactions by physical position. Displacement, stress and design were not calculated. / 按物理位置查询内力反力；没有计算位移、应力或设计。' }),
          { ...update, ...(delivery ? { resultQuantities: delivery.resultQuantities } : {}), ...(scope ? { requestScope: scope } : {}) });
      }

      // Read model from graph state channel
      const model = state?.model;
      if (!model) {
        return toolResult(toolCallId, 'run_analysis', JSON.stringify({ error: 'No model available. Run build_model first.' }));
      }
      if (state?.modelPending) return toolResult(toolCallId, 'run_analysis', JSON.stringify({ success: false, error_code: 'MODEL_REBUILD_REQUIRED', message: 'Build the pending model first.', messageZh: '请先构建待确认的模型。' }));
      assertInputEvidenceMatchesModel(model, state?.inputEvidence);
      const skillIds = configurable.skillScope;
      const analysisType = (input.analysisType || 'static') as 'static' | 'dynamic' | 'seismic' | 'nonlinear';
      const unselectedRequestedSkillId = resolveUnselectedRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
        input.analysisSkillId,
      );
      if (unselectedRequestedSkillId) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify(buildAnalysisProviderNotSelectedPayload(unselectedRequestedSkillId)),
        );
      }
      const requestedAnalysisSkillId = resolveRequestedAnalysisSkillId(
        state?.lastUserMessage,
        skillIds,
        analysisType,
        input.analysisSkillId,
      );
      const traceId = `lg-${Date.now()}`;
      const parsedSeismicWorkflow = parseJsonObjectInput(input.seismicWorkflowJson, 'seismicWorkflowJson');
      if (parsedSeismicWorkflow && !parsedSeismicWorkflow.ok) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify({
            success: false,
            error_code: 'INVALID_SEISMIC_WORKFLOW_JSON',
            message: parsedSeismicWorkflow.error,
          }),
        );
      }
      const draftSeismicWorkflow = isRecord(state?.draftState?.skillState?.seismicWorkflow)
        ? state?.draftState?.skillState?.seismicWorkflow as Record<string, unknown>
        : undefined;
      const contextSeismicWorkflow = isRecord(state?.contextSeismicWorkflow)
        ? state.contextSeismicWorkflow
        : undefined;
      const semanticSeismicWorkflow = parsedSeismicWorkflow?.ok
        ? parsedSeismicWorkflow.value
        : draftSeismicWorkflow ?? (
          hasSemanticSeismicWorkflowInput(contextSeismicWorkflow)
            ? contextSeismicWorkflow
            : undefined
        );
      const seismicWorkflow = mergeSeismicWorkflowInputs(
        semanticSeismicWorkflow,
        contextSeismicWorkflow,
      );
      assertAnalysisInputEvidenceMatchesRequest(state?.inputEvidence, analysisType === 'seismic' ? seismicWorkflow : undefined);
      if (analysisType === 'seismic' && !hasSemanticSeismicWorkflowInput(semanticSeismicWorkflow)) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify({
            success: false,
            error_code: 'SEISMIC_WORKFLOW_REQUIRED',
            message: 'China seismic analysis requires a non-empty structured seismicWorkflow from LLM semantic understanding before run_analysis.',
            messageZh: '中国抗震分析必须先由 LLM 语义理解形成非空 seismicWorkflow 结构化对象，不能直接按关键词进入计算。',
            nextAction: 'Call extract_draft_params or pass seismicWorkflowJson, then retry run_analysis.',
          }),
        );
      }
      if (analysisType === 'seismic' && hasStructuredSeismicWorkflow(seismicWorkflow)) {
        const workflowErrors = validateSeismicWorkflowInput(seismicWorkflow);
        if (workflowErrors.length > 0) {
          return toolResult(
            toolCallId,
            'run_analysis',
            JSON.stringify({
              success: false,
              error_code: 'INVALID_SEISMIC_WORKFLOW',
              message: 'China seismic workflow contains invalid structured fields.',
              messageZh: '中国抗震 seismicWorkflow 存在无效结构化字段。',
              errors: workflowErrors,
              nextAction: 'Correct seismicWorkflowJson or rerun extract_draft_params to produce valid structured fields.',
            }),
          );
        }
      }

      const engineClient = configurable.engineClient;
      const rawLoadCombinations = Array.isArray(model.load_combinations)
        ? model.load_combinations
        : Array.isArray(model.loadCombinations)
          ? model.loadCombinations
          : [];
      const loadCombinationIds = rawLoadCombinations
        .filter(isRecord)
        .map((combination) => pickStringLike(combination, 'id'))
        .filter((id): id is string => !!id);
      const requestedLoadCombinationId = input.loadCombinationId?.trim();
      if (requestedLoadCombinationId && !loadCombinationIds.includes(requestedLoadCombinationId)) {
        return toolResult(
          toolCallId,
          'run_analysis',
          JSON.stringify({
            success: false,
            error_code: 'LOAD_COMBINATION_NOT_FOUND',
            message: `Load combination '${requestedLoadCombinationId}' is not present in the current model.`,
            availableLoadCombinationIds: loadCombinationIds,
          }),
        );
      }
      const loadCombinationId = requestedLoadCombinationId;
      const parameters: Record<string, unknown> = {
        ...(loadCombinationId ? { loadCombinationId } : {}),
        ...(input.loadCaseIds ? { loadCaseIds: input.loadCaseIds } : {}),
        ...(input.loadCombinationIds ? { loadCombinationIds: input.loadCombinationIds } : {}),
        ...(input.floorLoadTransferMode ? { floorLoadTransferMode: input.floorLoadTransferMode } : {}),
        ...(analysisType === 'seismic' && seismicWorkflow ? { seismicWorkflow } : {}),
      };
      if (input.method !== undefined) parameters.analysisType = input.method;
      for (const key of ['massSource', 'numModes', 'direction', 'timeStep', 'duration', 'dampingRatio',
        'groundMotion', 'groundMotionUnit', 'monitorNodeIds', 'monitorElementIds', 'monitorSupportNodeIds', 'massDirections'] as const) {
        if (input[key] !== undefined) parameters[key] = input[key];
      }
      let reservation = beginAnalysisRequest(state ?? {}, analysisSettingsHash(analysisType, requestedAnalysisSkillId, parameters));
      const reserve = () => {
        configurable.agentState = { ...configurable.agentState, ...reservation } as AgentState;
        configurable.onAnalysisRequest?.(reservation);
      };
      reserve();
      const postToEngineWithRetry = async (
        p: string,
        payload: Record<string, unknown>,
        opts: { retries: number; traceId: string; tool: 'run_analysis'; signal?: AbortSignal },
      ) => {
        reservation = { ...reservation, analysisRequest: { ...reservation.analysisRequest,
          settingsHash: analysisSettingsHash(payload.type, payload.engineId, parameters) } };
        reserve();
        payload = { ...payload, ...(scope ? { requestScope: scope } : {}), requestId: randomUUID(), requestBinding: reservation.analysisRequest };
        if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Analysis request aborted');
        recordRunEvent({ kind: 'analysis_request', requestId: payload.requestId, operation: 'analysis', engineId: payload.engineId });
        try {
          return await engineClient.post(p, payload, { signal: opts.signal });
        } catch (error) {
          if (opts.signal?.aborted) throw error;
          throw new Error(`SOLVER_OUTCOME_UNKNOWN: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      };

      // engineId is resolved by the selected analysis skill, not from LLM input
      const result = await skillRuntime.executeAnalysisSkill({
        traceId,
        analysisType,
        model,
        parameters,
        analysisSkillId: requestedAnalysisSkillId,
        skillIds,
        postToEngineWithRetry,
        signal: config.signal,
      });
      const analysisResult: Record<string, unknown> = isRecord(result.result)
        ? { ...result.result }
        : { result: result.result };
      const analysisMeta = isRecord(analysisResult.meta) ? analysisResult.meta : {};
      for (const key of ['modelRevision', 'modelHash', 'settingsHash', 'requestSequence'] as const) {
        if (analysisMeta[key] !== undefined && analysisMeta[key] !== reservation.analysisRequest[key]) {
          throw new Error(`ANALYSIS_RESULT_BINDING_MISMATCH: ${key}`);
        }
      }
      analysisResult.meta = {
        ...analysisMeta,
        traceId,
        ...reservation.analysisRequest,
        ...(scope ? { requestScope: scope } : {}),
      };

      // Store analysis result in graph state via Command.
      // Keep ToolMessage content compact — the full data lives in graph state.
      // The streaming layer reads analysisResult from nodeState for artifact_payload_sync.
      const analysisSummary = buildAnalysisToolSummary({
        result: analysisResult,
        skillId: result.skillId,
        model,
      });
      const analysisSucceeded = analysisSummary.success !== false;
      const update = publishAnalysis(getConfigurable(config).agentState ?? {}, reservation.analysisRequest, analysisResult);
      const delivery = update.analysisResult && analysisSucceeded ? await queryRequestedOutputs({ ...state, ...reservation, ...update } as AgentState, scope, config) : undefined;
      logToolCall(log, {
        tool: 'run_analysis',
        durationMs: Date.now() - start,
        success: analysisSucceeded,
        extra: { analysisType, skillId: result.skillId, requestedAnalysisSkillId, success: analysisSucceeded },
      });
      return toolResult(
        toolCallId,
        'run_analysis',
        JSON.stringify({ ...analysisSummary, ...(delivery ? { requestedQuantities: delivery.requestedQuantities, missingRequestedOutputs: delivery.missingRequestedOutputs,
          deliveryStatus: delivery.missingRequestedOutputs.length ? 'partial' : 'complete' } : {}), ...(scope ? { requestScope: scope, requestedOutputs: scope.outputs,
          nextAction: 'query_results', instruction: 'Deliver the requested result locations, cases and units; code design/report only when explicitly requested. / 按指定位置、工况、单位交付；规范设计和报告分别按需。' } : {}) }),
        { ...update, ...(delivery ? { resultQuantities: delivery.resultQuantities } : {}), ...(scope ? { requestScope: scope } : {}) },
      );
    },
    {
      name: 'run_analysis',
      description:
        'Execute a structural analysis (static, dynamic, seismic, or nonlinear). ' +
        'Reads the model from conversation state automatically — do NOT pass it as a parameter. ' +
        'Returns analysis results including displacements, forces, and reactions, plus compact normalized-model ' +
        'node coordinates and element connectivity for grounding result IDs to physical locations. ' +
        'The analysis engine is resolved from the selected analysis skill automatically. ' +
        'For China seismic analysis, pass seismicWorkflowJson only as the structured result of semantic understanding.',
      schema: z.object({
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .default('static').describe('Type of analysis; default static, including equilibrium. method is separate. / 分析类型，缺省静力；equilibrium属于method。'),
        analysisSkillId: z
          .enum(ANALYSIS_SKILL_ID_VALUES)
          .optional()
          .describe('Optional structured analysis skill ID from LLM semantic understanding or UI selection. Do not infer it from keyword matching.'),
        loadCombinationId: z
          .string()
          .optional()
          .describe('Optional single load-combination ID. Without selectors, all declared static cases and combinations are run separately.'),
        loadCaseIds: z.array(z.string()).optional().describe('Explicit load cases to solve independently.'),
        loadCombinationIds: z.array(z.string()).optional().describe('Explicit combinations to solve independently.'),
        method: z.enum(['modal', 'time_history', 'equilibrium']).optional().describe('equilibrium: forces/reactions from accepted single-span beam draft, no stiffness or displacement; never substitutes for a specified solver. Otherwise modal/time_history / 平衡法只计算已接受单跨梁草稿的内力反力，不能替代指定引擎。'),
        allowPartial: z.boolean().optional().describe('Only for equilibrium: compute independently available forces first when the request also needs displacement but stiffness is missing. Missing responses remain explicit; never marks the full task complete. / 平衡法先交付独立内力；其余响应仍明确缺项，不能算整题完成。'),
        requestScope: requestScopeSchema.optional().describe('Requested response families and exact output locations/cases/units; design/report are independent opt-in deliverables. / 所求响应及明确位置、工况和单位；设计和报告分别按需。'),
        massSource: z.enum(['nodal', 'member-density', 'floor-seismic']).optional().describe('Explicit mass basis; sources are never silently added / 明确质量来源，不隐式叠加。'),
        numModes: z.number().int().positive().optional(),
        direction: z.enum(['x', 'y', 'z']).optional(),
        timeStep: z.number().positive().optional(),
        duration: z.number().positive().optional(),
        dampingRatio: z.number().min(0).lt(1).optional(),
        groundMotion: z.array(z.number().finite()).min(2).optional().describe('Actual acceleration samples / 实际加速度序列。'),
        groundMotionUnit: z.enum(['m/s2', 'g']).optional(),
        massDirections: z.array(z.enum(['x', 'y', 'z'])).min(1).optional().describe('Explicit mass directions / 明确质量方向。'),
        monitorElementIds: z.array(z.string().min(1)).optional().describe('Member end forces recorded at each step / 每步记录的构件端力。'),
        monitorSupportNodeIds: z.array(z.string().min(1)).optional().describe('Support reactions recorded at each step / 每步记录的支座反力。'),
        monitorNodeIds: z.array(z.string().min(1)).min(1).optional().describe('Nodes recorded at every time step / 每步记录的观测节点。'),
        floorLoadTransferMode: z
          .enum(['auto_code_cn', 'node_tributary', 'one_way_slab', 'two_way_slab'])
          .optional()
          .describe('Optional floor load transfer mode for OpenSees static analysis. Use auto_code_cn by default; set only when the user explicitly requests a method.'),
        seismicWorkflowJson: z
          .string()
          .optional()
          .describe('Optional JSON object produced by LLM semantic understanding for China seismic workflow. Used only when analysisType is seismic; do not infer this from keyword matching. It may include designBasis, designRequirements, structure, methodPreference, direction, and groundMotionSet.records with uploaded CSV headers/rows or AT2/TXT content returned by analyze_file.'),
      }),
    },
  );
}

export function createRunCodeCheckTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      designCode: string;
      engineId?: string;
      provider?: CodeCheckProvider;
      design?: Record<string, unknown>;
      requestScope?: RequestScope;
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const scope = input.requestScope ?? state?.requestScope;
      if (scope && !scope.design) return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: true,
        skipped: true, reason: 'DESIGN_NOT_REQUESTED', message: 'Analysis does not automatically request code design.',
        messageZh: '普通分析不自动进入规范设计；请只交付当前所求结果。' }));
      if (resultEngine(state?.analysisResult ?? {}) === 'equilibrium') throw new Error('DESIGN_REQUIRES_FULL_MODEL / 规范设计需要真实材料截面及完整模型，不能使用无刚度平衡投影');
      const skillIds = configurable.skillScope;
      const selectedDesignCode = skillRuntime.resolveCodeCheckDesignCodeFromSkillIds(skillIds);
      const explicitDesignCode = input.designCode || state?.policy?.designCode;
      const requestedDesignCode = explicitDesignCode || selectedDesignCode;
      const codeCheckSkillId = requestedDesignCode
        ? skillRuntime.resolveCodeCheckSkillId(requestedDesignCode)
        : undefined;
      if (!requestedDesignCode || (!codeCheckSkillId && input.provider === 'builtin')) {
        const skipped = {
          skipped: true,
          reason: requestedDesignCode
            ? `Unsupported code-check design code: ${requestedDesignCode}.`
            : 'No code-check design code is selected or provided.',
        };
        logToolCall(log, { tool: 'run_code_check', durationMs: Date.now() - start, extra: { skipped: true, reason: skipped.reason } });
        return toolResult(toolCallId, 'run_code_check', JSON.stringify(skipped));
      }

      // Read model and analysis from graph state channels
      const model = state?.model;
      if (!model) {
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ error: 'No model available. Run build_model first.' }));
      }
      const analysis = state?.analysisResult;
      if (!analysis) {
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ error: 'No analysis results available. Run run_analysis first.' }));
      }
      const freshnessError = currentAnalysisError(state);
      if (freshnessError) return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: false, error_code: freshnessError, message: 'Current model analysis is required.', messageZh: '需要当前模型的有效分析结果。' }));
      if (input.provider === 'native' && !['pkpm', 'yjk'].includes(resultEngine(analysis))) {
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: false,
          errorCode: 'NATIVE_DESIGN_ENGINE_REQUIRED', engine: resultEngine(analysis), allowedProviders: ['auto', 'builtin'],
          message: 'Native design requires a PKPM/YJK analysis. Use builtin checks for OpenSees; this is an engine mismatch, not a paid StructureClaw edition.',
          messageZh: '原生设计需要 PKPM/YJK 分析；当前 OpenSees 应使用内置校核。这是引擎不匹配，不是 StructureClaw 需要付费版本。',
          nextAction: 'Use provider auto/builtin without native design arguments; ask the user for missing model design inputs.' }));
      }
      if (resolveCheckProvider(input.provider, analysis) === 'native') {
        const meta = isRecord(analysis.meta) ? analysis.meta : {};
        const engineId = `builtin-${resultEngine(analysis)}`;
        if (input.engineId && input.engineId !== engineId) throw new Error('DESIGN_ENGINE_MISMATCH');
        const parameters = { ...(isRecord(meta.requestParameters) ? meta.requestParameters
          : isRecord(meta.effectiveParameters) ? meta.effectiveParameters : {}),
          design: { ...input.design, requested: true, code: requestedDesignCode } };
        const pending = beginNativeDesignRequest(state!, analysisSettingsHash('static', engineId, parameters));
        Object.assign(state!, pending.update, { analysisRuns: { ...state?.analysisRuns, ...pending.update.analysisRuns } });
        configurable.onAnalysisRequest?.(pending.update);
        const requestId = randomUUID();
        recordRunEvent({ kind: 'analysis_request', requestId, operation: 'native-design', engineId });
        const response = await configurable.engineClient.post<Record<string, unknown>>('/analyze', {
          type: 'static', engineId, model, parameters, requestId, requestBinding: pending.request }, { signal: config.signal })
          .catch((error: unknown) => {
            if (config.signal?.aborted) throw error;
            throw new Error(`SOLVER_OUTCOME_UNKNOWN: requestId=${requestId}; ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          });
        const next = response.data;
        const designRecord = nativeDesignRecord(model, next, requestedDesignCode);
        const published = publishNativeDesign(getConfigurable(config).agentState ?? state!, pending.request, next, designRecord);
        return toolResult(toolCallId, 'run_code_check', JSON.stringify({ success: next.success === true,
          provider: 'native', runId: next.runId, completionStatus: designRecord.completionStatus,
          complianceStatus: designRecord.complianceStatus, summary: designRecord.summary,
          missingInputs: designRecord.missingInputs, designStatus: designRecord.designStatus }),
          published);
      }
      if (!codeCheckSkillId) throw new Error('BUILTIN_CODE_UNSUPPORTED / 公共规范未实现');
      if (skillIds && !skillIds.includes(codeCheckSkillId)) throw new Error('CODE_CHECK_OUTSIDE_SCOPE / 当前技能范围不允许此规范');
      if (input.design) throw new Error('BUILTIN_DESIGN_REQUEST_UNSUPPORTED / 公共校核不执行商业设计条件');
      const traceId = `lg-cc-${Date.now()}`;

      const codeCheckResult = await checkRunResults(analysis, async (caseResult) => {
        const result = await skillRuntime.executeCodeCheckSkill({
        codeCheckClient: configurable.codeCheckClient,
        traceId,
        designCode: requestedDesignCode,
        model,
        analysis: caseResult,
        analysisParameters: {},
        engineId: input.engineId,
        codeCheckSkillId,
        });
        return isRecord(result.result) ? result.result : { result: result.result };
      });

      const codeCheckPayload: Record<string, unknown> = { ...codeCheckResult };
      const meta = isRecord(codeCheckPayload.meta) ? codeCheckPayload.meta : {};
      const analysisTraceId = analysisTraceIdFromResult(analysis);
      codeCheckPayload.meta = {
        ...meta, codeCheckSkillId, ...(analysisTraceId ? { analysisTraceId } : {}),
        runId: analysis.runId, modelHash: modelHash(model), modelRevision: state?.modelRevision,
      };

      // Store code check result in graph state via Command
      logToolCall(log, { tool: 'run_code_check', durationMs: Date.now() - start, extra: { designCode: requestedDesignCode, skillId: codeCheckSkillId, success: true } });
      return toolResult(
        toolCallId,
        'run_code_check',
        JSON.stringify({ success: true, provider: 'builtin', engine: resultEngine(analysis), skillId: codeCheckSkillId, ...codeCheckFeedback(codeCheckPayload) }),
        { codeCheckResult: codeCheckPayload },
      );
    },
    {
      name: 'run_code_check',
      description:
        'Run code compliance check against a design code (e.g. GB50017, GB50010, GB50011, GB/T 50011-2010-2024). ' +
        'Reads model and analysis results from conversation state automatically — do NOT pass them as parameters. ' +
        'For China seismic analysis, call this after run_analysis and before generate_report with designCode GB/T 50011-2010-2024. ' +
        'Returns completion and compliance separately, with specific missing inputs. Incomplete is NOT pass. ' +
        'For OpenSees use auto/builtin, never native; native design belongs to PKPM/YJK. ' +
        'When inputs are missing ask the user, update declared material/member design fields via edit_model, reanalyze the updated model, then check again. Never invent design conditions.',
      schema: z.object({
        designCode: z
          .string()
          .describe('Design code to check against (GB50010, GB50011, GB/T 50011-2010-2024, GB50017, JGJ3)'),
        provider: z.enum(['auto', 'native', 'builtin']).optional().describe('Commercial engines prefer native design; OpenSees uses builtin checks / 商业引擎优先原生设计，OpenSees采用公共校核。'),
        design: z.record(z.string(), z.unknown()).optional().describe('Explicit native design conditions / 明确的原生设计条件。'),
        engineId: z.string().optional().describe('Optional engine ID'),
        requestScope: requestScopeSchema.optional().describe('Update the goal only when the user now explicitly requests design; preserve requested outputs. / 仅在用户明确请求设计时更新目标，保留所求结果。'),
      }),
    },
  );
}

export function createGenerateReportTool(skillRuntime: AgentSkillRuntime) {
  return tool(
    async (input: {
      message: string;
      analysisType: string;
      locale?: string;
      selection?: ResultSelection;
      narrative?: 'structured' | 'assisted';
      requestScope?: RequestScope;
    }, config: LangGraphRunnableConfig) => {
      const log = getLogger(config.configurable as Partial<AgentConfigurable> | undefined);
      const start = Date.now();
      const configurable = getConfigurable(config);
      const state = configurable.agentState;
      const toolCallId = getToolCallId(config);
      const scope = input.requestScope ?? state?.requestScope;
      if (scope && !scope.report) return toolResult(toolCallId, 'generate_report', JSON.stringify({ success: true,
        skipped: true, reason: 'REPORT_NOT_REQUESTED', message: 'Deliver the requested results without a full report.',
        messageZh: '用户未要求计算书；交付所求结果及计算依据即可。' }));

      const selection = input.selection;
      if (selection?.timeIndex !== undefined && selection.modeNumber !== undefined) throw new Error('RESULT_INDEX_CONFLICT');
      const run = selection?.runId ? state?.analysisRuns?.[selection.runId]
        ?? (state?.analysisResult?.runId === selection.runId ? state.analysisResult : await loadAnalysisRun(selection.runId)) : state?.analysisResult;
      if (!run) return toolResult(toolCallId, 'generate_report', JSON.stringify({ error: 'RUN_NOT_FOUND' }));
      const freshnessError = currentAnalysisError(state);
      if (!selection?.runId && freshnessError) return toolResult(toolCallId, 'generate_report', JSON.stringify({ success: false,
        error_code: freshnessError, message: 'Current model analysis is required.', messageZh: '需要当前模型的有效分析结果。' }));
      const { resultKey, selected } = selectedSavedResult(run, selection?.resultKey);
      if (selected.success === false || selected.executionStatus === 'failed') throw new Error('RESULT_UNAVAILABLE');
      const quantities = Object.values(state?.resultQuantities ?? {}).filter(q => selection
        ? quantityMatchesSelection(q, selection, run.runId, resultKey) : q.runId === run.runId);
      if (selection && (selection.component || selection.timeIndex !== undefined || selection.modeNumber !== undefined) && !quantities.length) {
        throw new Error(`REPORT_SELECTION_QUERY_REQUIRED: call query_results first with the same run, result, location, component, unit and index, then retry this report. A full-field query does not save a scalar. quantityId is automatic; do not ask the user for it. / 请先用query_results查询同一运行、结果、位置、分量、单位和索引，再生成报告。整个字段的查询不会登记标量；quantityId自动生成，不需要询问用户。 query_results: ${JSON.stringify({ ...selection, runId: run.runId, resultKey })}`);
      }
      const analysis = { ...run, ...(selection ? selected : {}), runId: run.runId, selectedResultKey: resultKey,
        results: selection && resultKey ? { [resultKey]: selected } : run.results,
        requestedQuantities: quantities, requestedSelection: selection };
      const normalizedModel = isRecord(run.modelSnapshot) ? run.modelSnapshot : !freshnessError && run.runId === state?.analysisResult?.runId ? state?.model : undefined;
      if (!normalizedModel) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
      const currentCheck = state?.codeCheckResult;
      const codeCheck = !selection || (isRecord(currentCheck?.meta) && currentCheck.meta.runId === run.runId)
        ? currentCheck : savedNativeDesignRecord(run) ?? undefined;
      const draftState = selection?.runId ? undefined : state?.draftState || undefined;
      const skillIds = configurable.skillScope;
      const locale = (input.locale ?? state?.locale ?? 'zh') as 'zh' | 'en';
      const analysisType = inferAnalysisTypeFromResult(run) ?? normalizeAnalysisType(input.analysisType) ?? 'static';
      const workflowInputMode = analysisWorkflowInputModeFromResult(analysis);
      if (analysisType === 'seismic' && workflowInputMode !== 'structured_seismic_workflow') {
        return toolResult(toolCallId, 'generate_report', JSON.stringify({
          success: false,
          error_code: 'SEISMIC_WORKFLOW_REQUIRED',
          error: 'China seismic reports require analysis results produced from a structured seismicWorkflow, not the lower-level legacy compatibility parameter path.',
          messageZh: '中国抗震计算书必须基于结构化 seismicWorkflow 分析结果生成，不能使用底层旧参数兼容路径生成正式计算书。',
          workflowInputMode: workflowInputMode ?? null,
          nextAction: 'Call extract_draft_params or pass seismicWorkflowJson, rerun run_analysis and run_code_check, then retry generate_report.',
        }));
      }
      if (analysisType === 'seismic' && scope?.design !== false && !hasValidChinaSeismicCodeCheck(codeCheck, analysis)) {
        return toolResult(toolCallId, 'generate_report', JSON.stringify({
          success: false,
          error_code: 'SEISMIC_CODE_CHECK_REQUIRED',
          error: 'China seismic reports require run_code_check with GB/T 50011-2010-2024 after run_analysis. Call run_code_check first, then retry generate_report.',
          messageZh: '中国抗震报告必须先完成 GB/T 50011-2010(2024) 抗震规范校核；请先调用 run_code_check，再重试 generate_report。',
          requiredCodeCheckSkillId: 'code-check-gb50011',
          actualCodeCheckSkillId: codeCheckSkillIdFromResult(codeCheck),
        }));
      }

      const result = input.narrative === 'structured' ? { report: createEngineeringReport({
        message: input.message, analysisType, normalizedModel, analysis, codeCheck, locale, reportSource: 'selected-result' }) }
        : await skillRuntime.executeReportSkill({
        message: input.message,
        analysisType,
        normalizedModel,
        analysis,
        codeCheck,
        format: 'both',
        locale,
        draft: draftState,
        skillIds,
      });

      await attachNativeReport({ ...result.report, markdown: result.report.markdown ?? '' }, {
        message: input.message, analysisType, normalizedModel, analysis, codeCheck, locale,
      });

      // Store report in graph state via Command
      logToolCall(log, { tool: 'generate_report', durationMs: Date.now() - start, extra: { analysisType, locale, success: true } });
      return toolResult(
        toolCallId,
        'generate_report',
        JSON.stringify({ success: true, summary: result.report.summary, ...(selection ? { report: result.report } : {}) }),
        selection ? {} : { report: result.report as unknown as Record<string, unknown> },
      );
    },
    {
      name: 'generate_report',
      description:
        'Generate an engineering report with summary, key metrics, and compliance narrative. ' +
        'Reads analysis results, code check results, and draft state from conversation state automatically — ' +
        'do NOT pass them as parameters. ' +
        'Requires run_analysis to have been called first. For a scalar selection, first call query_results with the identical run/result, location, component, unit and index; reading a full field alone does not register the scalar. The query assigns quantityId automatically. / 指定标量selection前须先用query_results查询同一运行/结果、位置、分量、单位与索引；整个字段查询不会登记标量，数值ID自动生成。 ' +
        'For China seismic reports, run_code_check with GB/T 50011-2010-2024 must be called first.',
      schema: z.object({
        message: z.string().describe('Original user message / intent'),
        analysisType: z
          .enum(['static', 'dynamic', 'seismic', 'nonlinear'])
          .describe('Analysis type that was performed'),
        locale: z.enum(['zh', 'en']).optional().describe('Report language'),
        selection: resultSelectionSchema.optional().describe('Saved run/result and optional scalar already registered by query_results using exactly the same component, unit, location and index. Omit to report the current run. Does not replace the current report. / 保存的运行/结果及已由query_results登记的同分量、单位、位置、索引标量。省略则报告当前运行；指定selection不覆盖当前报告。'),
        narrative: z.enum(['structured', 'assisted']).optional().describe('structured produces a deterministic report without an extra language-model call. / structured直接生成结构化报告，不额外调用语言模型。'),
        requestScope: requestScopeSchema.optional().describe('Update the goal only when the user explicitly asks for a report. / 用户明确要求报告时更新目标。'),
      }),
    },
  );
}

