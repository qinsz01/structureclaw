import { requestScopeSchema, type RequestScope } from '../engineering/request-scope.js';
/**
 * LangGraph-based AgentService — the sole agent implementation.
 *
 * Provides streaming, synchronous, and resumption entry points for the
 * LangGraph ReAct agent, plus conversation/session management methods.
 *
 * Dependency injection uses config.configurable (no globalThis).
 * The graph is built once and cached for the process lifetime.
 */
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { AgentSkillRuntime } from '../agent-runtime/index.js';
import type { SkillManifest } from '../agent-runtime/types.js';
import { applyToolsNodeSessionContext, buildAgentGraph } from './graph.js';
import { FileCheckpointer } from './file-checkpointer.js';
import { streamGraphToChunks, type StreamContext } from './streaming.js';
import type { AgentState, AgentToolAccessPolicy } from './state.js';
import { getAllowShellTools, getCheckpointerDataDir, getWorkspaceRoot, getWorkspaceSkillRoot } from './config.js';
import { config, runtimeBaseDir } from '../config/index.js';
import type { RunPolicyInput, EffectiveRunPolicy } from '../runtime/run-policy.js';
import { resolveApplicationRunPolicy } from '../runtime/policy-settings.js';
import { createRunContext, withRunContext, snapshotRunUsage, readRunUsage, recordRunEvent, type RunContext, type RunUsage } from '../runtime/run-context.js';
import type { ConversationRuntimeSnapshot } from '../types/conversation-runtime.js';
import type { AgentStreamChunk } from '../types/agent-stream.js';
import type { AppLocale } from '../services/locale.js';
import { AnalysisExecutionService, createLocalAnalysisEngineClient } from '../services/analysis-execution.js';
import { createLocalCodeCheckClient } from '../services/code-check-execution.js';
import { createLocalStructureProtocolClient } from '../services/structure-protocol-execution.js';
import { prisma } from '../utils/database.js';
import { Command } from '@langchain/langgraph';
import { logger } from '../utils/logger.js';
import { createAgentLogger } from '../utils/agent-logger.js';
import { normalizeClarificationOptions } from '../utils/clarification-options.js';
import type { AgentConfigurable } from './configurable.js';
import { createRegisteredTools, listAgentToolDefinitions } from './tool-registry.js';
import { executeToolsSequentially, pendingToolCalls } from './sequential-tools.js';
import { resolveActiveToolIds } from './tool-policy.js';
import { analyzeUploadedFile, isPathWithinRoot, resolveUploadPath } from './file-tools.js';
import { summarizeFileImages } from './attachment-vision.js';
import { collectVisionEvidence } from '../engineering/vision-evidence.js';
import { activeInputEvidence, assertInputEvidenceMatchesModel, mergeInputEvidence, unresolvedInputEvidence } from '../engineering/input-evidence.js';
import { SessionLock } from '../engineering/session-lock.js';
import { applyInputEvidence, commitModel, contentHash, currentAnalysisError, invalidateAnalysis } from '../engineering/model-state.js';
import { resultCatalogEntry } from '../engineering/result-selection.js';
import { nativeDesignReview } from '../engineering/native-design-options.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttachmentInfo {
  fileId: string;
  originalName: string;
  relPath: string;
  mimeType?: string;
}

export interface LangGraphRunInput {
  message: string;
  conversationId?: string;
  traceId?: string;
  signal?: AbortSignal;
  context?: {
    runPolicy?: RunPolicyInput;
    requestScope?: RequestScope;
    locale?: AppLocale;
    skillIds?: string[];
    enabledToolIds?: string[];
    disabledToolIds?: string[];
    model?: Record<string, unknown>;
    modelFormat?: string;
    modelRevision?: number;
    analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
    engineId?: string;
    designCode?: string;
    includeReport?: boolean;
    seismicWorkflow?: Record<string, unknown>;
    attachments?: AttachmentInfo[];
    restrictFileAccessToAttachments?: boolean;
  };
}

export function buildToolAccessPolicy(
  context: LangGraphRunInput['context'] | undefined,
): AgentToolAccessPolicy {
  return {
    enabledToolIds: Array.isArray(context?.enabledToolIds)
      ? [...context.enabledToolIds]
      : null,
    disabledToolIds: Array.isArray(context?.disabledToolIds)
      ? [...context.disabledToolIds]
      : null,
    fileAccessAllowlist: context?.restrictFileAccessToAttachments
      ? (context.attachments ?? []).map((attachment) => attachment.relPath)
      : null,
  };
}

export interface LangGraphRunResult {
  runPolicy?: EffectiveRunPolicy;
  runUsage?: RunUsage;
  conversationId: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
  success: boolean;
  response: string;
  waitingForReply: boolean;
  question: string | null;
  options: string[];
  mode: 'conversation' | 'execution';
  toolCalls: unknown[];
  model?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  report?: Record<string, unknown>;
  draftState?: Record<string, unknown>;
  presentation?: Record<string, unknown>;
}

export const INPUT_REVIEW_TOOLS = ['analyze_file', 'review_input', 'query_model', 'edit_model', 'validate_model'] as const;
export type InputReviewTool = typeof INPUT_REVIEW_TOOLS[number];
export const RESULT_REVIEW_TOOLS = ['query_results', 'generate_report', 'run_code_check'] as const;
export type ResultReviewTool = typeof RESULT_REVIEW_TOOLS[number];

function clarificationState(state: AgentState, tasks: ReadonlyArray<{ interrupts?: readonly unknown[] }> = []) {
  const call = state.messages?.length ? pendingToolCalls(state)[0] : undefined;
  const waitingForReply = tasks.some(task => task.interrupts?.length) || call?.name === 'ask_user_clarification';
  const args = call?.name === 'ask_user_clarification' ? call.args : undefined;
  return { waitingForReply, question: typeof args?.question === 'string' ? args.question : null,
    options: normalizeClarificationOptions(args?.options ?? args?.optionsJson) };
}

/** A revision covers evidence and excitation settings as well as the physical model. */
export function inputReviewRevision(state: Partial<AgentState>): string {
  return contentHash({ model: state.model, revision: state.modelRevision, pending: state.modelPending,
    evidence: state.inputEvidence, workflow: state.contextSeismicWorkflow, policy: state.runPolicy,
    usage: state.runUsage, analysisRequest: state.analysisRequest, currentRun: state.analysisResult?.runId,
    runs: Object.keys(state.analysisRuns ?? {}), quantities: state.resultQuantities, messages: state.messages?.map(message => message.id) });
}

/** Ownership comes only from this checkpoint and its existing ledger, never a global job scan. */
function conversationJobReferences(state: AgentState, usage: RunUsage | null) {
  const references = new Map<string, { operation: string; runId?: string; inHistory: boolean }>();
  const runs = { ...(state.analysisRuns ?? {}) };
  if (typeof state.analysisResult?.runId === 'string') runs[state.analysisResult.runId] = state.analysisResult;
  for (const run of Object.values(runs)) {
    if (typeof run.requestId !== 'string' || typeof run.runId !== 'string') continue;
    const parameters = isRecord(run.meta) && isRecord(run.meta.requestParameters) ? run.meta.requestParameters : {};
    references.set(run.requestId, { operation: isRecord(parameters.design) && parameters.design.requested === true ? 'native-design' : 'analysis',
      runId: run.runId, inHistory: true });
  }
  for (const event of usage?.events ?? []) {
    if (event.kind !== 'analysis_request' || typeof event.requestId !== 'string') continue;
    references.set(event.requestId, { ...references.get(event.requestId), operation: String(event.operation),
      inHistory: references.get(event.requestId)?.inHistory ?? false });
  }
  return references;
}

type HumanMessageContentBlock =
  | { type: 'text'; text: string };

interface InitialHumanMessagePayload {
  content: string | HumanMessageContentBlock[];
  canonicalMessage: string;
  attachmentAnalyses: AttachmentAnalysis[];
}

interface InitialHumanMessageOptions {
  summarizeImages?: boolean;
  signal?: AbortSignal;
}

export interface AttachmentAnalysis {
  attachment: AttachmentInfo;
  analysis: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getLangGraphRecursionLimit(maxToolCallsPerTurn: number | undefined): number {
  const toolLimit = typeof maxToolCallsPerTurn === 'number' && Number.isFinite(maxToolCallsPerTurn) && maxToolCallsPerTurn > 0
    ? maxToolCallsPerTurn
    : 200;
  return Math.max(50, toolLimit * 2 + 10);
}

function buildAttachmentBlock(attachments: AttachmentInfo[] | undefined, locale: AppLocale): string {
  if (!attachments || attachments.length === 0) return '';
  const header = locale === 'zh' ? '[已上传文件]' : '[Attached files]';
  const instruction = locale === 'zh'
    ? '下面会提供附件的解析内容。请基于已解析文本、DXF 几何或视觉摘要识别结构类型、尺寸、荷载和边界条件；如果关键信息缺失，请追问。'
    : 'Parsed attachment content follows. Use parsed text, DXF geometry, or vision summaries to identify structural type, dimensions, loads, and boundary conditions; ask for clarification when critical information is missing.';
  const lines = attachments.map(a => `- ${a.originalName} (${a.relPath})`);
  return `\n\n${header}\n${instruction}\n${lines.join('\n')}`;
}

function sanitizeAttachmentNote(note: string): string {
  return note.replace(/\bbase64DataUri\b/g, 'image binary data');
}

function compactAttachmentAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...analysis };
  delete rest.base64DataUri;
  if (rest.type === 'image') {
    rest.note = typeof rest.note === 'string'
      ? sanitizeAttachmentNote(rest.note)
      : 'Image binary is parsed only by the configured vision model; the main agent receives text summaries only.';
  }
  return rest;
}

function compactAttachmentAnalysisMetadata(analysis: Record<string, unknown>): Record<string, unknown> {
  const rest = compactAttachmentAnalysis(analysis);
  delete rest.rows;
  delete rest.content;
  delete rest.text;
  delete rest.csv;
  delete rest.at2;
  delete rest.data;
  delete rest.sheets;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function attachmentSummary(attachment: AttachmentInfo): Record<string, unknown> {
  return {
    fileId: attachment.fileId,
    originalName: attachment.originalName,
    relPath: attachment.relPath,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  };
}

function analysisRowsRecord(
  attachment: AttachmentInfo,
  analysis: Record<string, unknown>,
  idSuffix?: string,
): Record<string, unknown> | null {
  const rows = analysis.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const sheetLabel = idSuffix ? `:${idSuffix}` : '';
  return {
    id: `${attachment.fileId || attachment.relPath || attachment.originalName}${sheetLabel}`,
    name: idSuffix ? `${attachment.originalName}:${idSuffix}` : attachment.originalName,
    recordType: 'actual',
    source: 'uploaded_attachment',
    fileId: attachment.fileId,
    relPath: attachment.relPath,
    ...(idSuffix ? { sheetName: idSuffix } : {}),
    ...(analysis.fileReference ? { fileReference: analysis.fileReference }
      : { ...(Array.isArray(analysis.headers) ? { headers: analysis.headers } : {}), rows }),
    fileAnalysis: compactAttachmentAnalysisMetadata(analysis),
  };
}

function finiteCellNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numericRows(rows: unknown): number[][] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => Array.isArray(row)
      ? row.every(cell => finiteCellNumber(cell) !== null) ? row.map(cell => finiteCellNumber(cell)!) : []
      : [])
    .filter((row) => row.length > 0);
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isNumericHeaderRow(headers: unknown): boolean {
  return Array.isArray(headers)
    && headers.length > 0
    && headers.every((header) => finiteCellNumber(header) !== null);
}

function hasMotionHeaders(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const normalized = headers.map(normalizeHeader);
  const hasTime = normalized.some((header) =>
    ['time', 't', 'sec', 'second', 'seconds'].includes(header)
    || header.includes('time')
    || header.includes('(s)'));
  const hasAcceleration = normalized.some((header) =>
    ['acc', 'ag', 'a', 'gal', 'g'].includes(header)
    || header.includes('accel')
    || header.includes('acceler')
    || header.includes('cm/s')
    || header.includes('m/s'));
  return hasTime && hasAcceleration;
}

function hasClearlyNonMotionHeaders(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  const normalized = headers.map(normalizeHeader).join(' ');
  return [
    'story',
    'floor',
    'load',
    'force',
    'node',
    'element',
    'member',
    'beam',
    'column',
    'region',
    'intensity',
    'designgroup',
    'design group',
    'sitecategory',
    'site category',
    'alphamax',
    'alpha max',
    'characteristicperiod',
  ].some((token) => normalized.includes(token));
}

function hasLikelyGroundMotionTimeColumn(rows: number[][]): boolean {
  const timeValues = rows
    .filter((row) => row.length >= 2)
    .map((row) => row[0]);
  if (timeValues.length < 3) return false;
  const deltas = timeValues.slice(1).map((value, index) => value - timeValues[index]);
  return deltas.every((delta) => delta > 0 && delta <= 0.5);
}

function looksLikeGroundMotionRows(analysis: Record<string, unknown>): boolean {
  const rows = numericRows(analysis.rows);
  if (rows.length < 3) return false;
  if (hasMotionHeaders(analysis.headers)) return rows.some((row) => row.length >= 2);
  if (hasClearlyNonMotionHeaders(analysis.headers)) return false;
  if (!isNumericHeaderRow(analysis.headers)) return false;
  if (rows.every((row) => row.length === 1)) return rows.length >= 8;
  return hasLikelyGroundMotionTimeColumn(rows);
}

function looksLikeGroundMotionText(analysis: Record<string, unknown>): boolean {
  const ext = typeof analysis.ext === 'string' ? analysis.ext.toLowerCase() : '';
  const content = typeof analysis.content === 'string' ? analysis.content : '';
  if (!content.trim()) return false;
  if (ext === '.at2') return true;
  if (ext !== '.txt') return false;
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numericLines = lines.filter((line) => {
    const values = line.split(/[\s,;]+/).map(finiteCellNumber).filter((value) => value !== null);
    return values.length > 0 && values.length === line.split(/[\s,;]+/).filter(Boolean).length;
  });
  return numericLines.length >= 4 && numericLines.length >= Math.ceil(lines.length * 0.5);
}

function looksLikeGroundMotionAttachmentAnalysis(analysis: Record<string, unknown>): boolean {
  const type = typeof analysis.type === 'string' ? analysis.type : '';
  if (type === 'csv') return looksLikeGroundMotionRows(analysis);
  if (type === 'text') return looksLikeGroundMotionText(analysis);
  if (type === 'excel' && isRecord(analysis.sheets)) {
    return Object.values(analysis.sheets).some((sheetValue) =>
      isRecord(sheetValue) && looksLikeGroundMotionRows(sheetValue));
  }
  return false;
}

function groundMotionAttachmentAnalyses(
  attachmentAnalyses: AttachmentAnalysis[],
): AttachmentAnalysis[] {
  return attachmentAnalyses.filter(({ analysis }) => looksLikeGroundMotionAttachmentAnalysis(analysis));
}

function groundMotionRecordsFromAttachmentAnalyses(attachmentAnalyses: AttachmentAnalysis[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const { attachment, analysis } of attachmentAnalyses) {
    const type = typeof analysis.type === 'string' ? analysis.type : '';
    if (type === 'csv') {
      const record = analysisRowsRecord(attachment, analysis);
      if (record) records.push(record);
      continue;
    }
    if (type === 'text') {
      const content = typeof analysis.content === 'string' ? analysis.content : '';
      if (content.trim()) {
        records.push({
          id: attachment.fileId || attachment.relPath || attachment.originalName,
          name: attachment.originalName,
          recordType: 'actual',
          source: 'uploaded_attachment',
          fileId: attachment.fileId,
          relPath: attachment.relPath,
          ...(analysis.fileReference ? { fileReference: analysis.fileReference } : { content }),
          fileAnalysis: compactAttachmentAnalysisMetadata(analysis),
        });
      }
      continue;
    }
    if (type === 'excel' && isRecord(analysis.sheets)) {
      for (const [sheetName, sheetValue] of Object.entries(analysis.sheets)) {
        if (!isRecord(sheetValue)) continue;
        if (!looksLikeGroundMotionRows(sheetValue)) continue;
        const record = analysisRowsRecord(attachment, { ...sheetValue, fileReference: analysis.fileReference }, sheetName);
        if (record) {
          records.push({
            ...record,
            fileAnalysis: {
              ...compactAttachmentAnalysisMetadata(sheetValue),
              workbook: compactAttachmentAnalysisMetadata(analysis),
            },
          });
        }
      }
    }
  }
  return records;
}

function uploadedGroundMotionWorkflowFromAttachmentAnalyses(
  attachmentAnalyses: AttachmentAnalysis[],
): Record<string, unknown> | null {
  const groundMotionAnalyses = groundMotionAttachmentAnalyses(attachmentAnalyses);
  const records = groundMotionRecordsFromAttachmentAnalyses(groundMotionAnalyses);
  if (records.length === 0) {
    return null;
  }
  return {
    groundMotionSet: {
      source: 'uploaded',
      uploadedAttachments: groundMotionAnalyses.map(({ attachment }) => attachmentSummary(attachment)),
      records,
    },
  };
}

export function enrichUploadedGroundMotionWorkflow(
  seismicWorkflow: Record<string, unknown>,
  attachmentAnalyses: AttachmentAnalysis[],
): Record<string, unknown> {
  const groundMotionSet = isRecord(seismicWorkflow.groundMotionSet)
    ? seismicWorkflow.groundMotionSet
    : undefined;
  const source = typeof groundMotionSet?.source === 'string'
    ? groundMotionSet.source.trim().toLowerCase()
    : '';
  if (source !== 'uploaded' || !groundMotionSet) {
    return seismicWorkflow;
  }

  const groundMotionAnalyses = groundMotionAttachmentAnalyses(attachmentAnalyses);
  const uploadedAttachments = groundMotionAnalyses.map(({ attachment }) => attachmentSummary(attachment));
  const existingRecords = Array.isArray(groundMotionSet.records) ? groundMotionSet.records : undefined;
  const fullRecords = groundMotionRecordsFromAttachmentAnalyses(groundMotionAnalyses);
  const generatedRecords = existingRecords && existingRecords.length > 0
    ? existingRecords.map(record => {
      if (!isRecord(record)) return record;
      const matches = fullRecords.filter(full => record.id === full.id
        || ((record.fileId !== undefined && record.fileId === full.fileId
          || record.relPath !== undefined && record.relPath === full.relPath) && record.sheetName === full.sheetName));
      if (matches.length !== 1 || !matches[0]!.fileReference) return record;
      // Keep explicit sampling settings; samples always come from the complete source.
      const result = { ...record, ...matches[0], ...Object.fromEntries(Object.entries(record)
        .filter(([key]) => ['unit', 'direction', 'component', 'axis', 'seismicDirection', 'dt', 'timeStep', 'time_step',
          'timeUnit', 'timeColumn', 'accelerationColumn', 'accelColumn', 'valueColumn', 'recordType'].includes(key))) };
      for (const key of ['values', 'accelerations', 'accel', 'rows', 'content', 'text', 'csv', 'at2', 'data']) delete result[key];
      return result;
    }) : fullRecords;

  return {
    ...seismicWorkflow,
    groundMotionSet: {
      ...groundMotionSet,
      uploadedAttachments,
      ...(generatedRecords.length > 0 ? { records: generatedRecords } : {}),
    },
  };
}

export function extractContextSeismicWorkflow(
  context?: LangGraphRunInput['context'],
  attachmentAnalyses: AttachmentAnalysis[] = [],
): Record<string, unknown> | null {
  const seismicWorkflow = context?.seismicWorkflow;
  if (!isRecord(seismicWorkflow) || Object.keys(seismicWorkflow).length === 0) {
    return uploadedGroundMotionWorkflowFromAttachmentAnalyses(attachmentAnalyses);
  }
  return enrichUploadedGroundMotionWorkflow(seismicWorkflow, attachmentAnalyses);
}

function attachmentAnalysisText(
  attachment: AttachmentInfo,
  analysis: Record<string, unknown>,
  locale: AppLocale,
): string {
  const header = locale === 'zh'
    ? `[附件解析: ${attachment.originalName}]`
    : `[Attachment analysis: ${attachment.originalName}]`;
  return `${header}\n${JSON.stringify(compactAttachmentAnalysis(analysis), null, 2)}`;
}

function attachmentVisionSummaryText(
  attachment: AttachmentInfo,
  summary: string,
  locale: AppLocale,
): string {
  const header = locale === 'zh'
    ? `[附件视觉摘要: ${attachment.originalName}]`
    : `[Attachment vision summary: ${attachment.originalName}]`;
  return `${header}\n${summary}`;
}

function attachmentVisionUnavailableText(
  attachment: AttachmentInfo,
  locale: AppLocale,
): string {
  const header = locale === 'zh'
    ? `[附件视觉摘要不可用: ${attachment.originalName}]`
    : `[Attachment vision summary unavailable: ${attachment.originalName}]`;
  const body = locale === 'zh'
    ? '未配置独立 vision 模型或 vision 模型调用失败。不要假设图片中的尺寸、荷载或边界条件；如需继续分析，请向用户追问缺失信息。'
    : 'No independent vision model is configured or the vision call failed. Do not assume dimensions, loads, or boundary conditions from this image; ask the user for missing information before analysis.';
  return `${header}\n${body}`;
}

function toInitialHumanMessage(content: string | HumanMessageContentBlock[]): HumanMessage {
  return Array.isArray(content)
    ? new HumanMessage({ content })
    : new HumanMessage(content);
}

function shouldKeepFullAttachmentAnalysis(
  attachment: AttachmentInfo,
  analysis: Record<string, unknown>,
): boolean {
  const name = `${attachment.originalName} ${attachment.relPath}`.toLowerCase();
  const type = typeof analysis.type === 'string' ? analysis.type : '';
  return type === 'excel' || (type === 'csv' || type === 'text')
    && (
      name.endsWith('.csv')
      || name.endsWith('.tsv')
      || name.endsWith('.at2')
      || name.endsWith('.txt')
    );
}

export async function buildInitialHumanMessagePayload(
  message: string,
  attachments: AttachmentInfo[] | undefined,
  locale: AppLocale,
  workspaceRoot: string,
  options: InitialHumanMessageOptions = {},
): Promise<InitialHumanMessagePayload> {
  const attachmentBlock = buildAttachmentBlock(attachments, locale);
  if (!attachments || attachments.length === 0) {
    return { content: message, canonicalMessage: message, attachmentAnalyses: [] };
  }

  const contentParts = [message + attachmentBlock];
  const canonicalParts = [message + attachmentBlock];
  const attachmentAnalyses: AttachmentAnalysis[] = [];

  for (const attachment of attachments) {
    const rawAnalysis = await analyzeUploadedFile(attachment.relPath, workspaceRoot, undefined, { includeImageData: true });
    const analysis = options.summarizeImages && ['image', 'pdf'].includes(String(rawAnalysis.type))
      ? await summarizeFileImages(rawAnalysis, attachment.relPath, locale, message, options.signal) : rawAnalysis;
    const runtimeAnalysis = shouldKeepFullAttachmentAnalysis(attachment, analysis)
      ? await analyzeUploadedFile(attachment.relPath, workspaceRoot, undefined, { mode: 'full' }) : analysis;
    runtimeAnalysis.inputEvidence = mergeInputEvidence(collectVisionEvidence(analysis), collectVisionEvidence(runtimeAnalysis));
    attachmentAnalyses.push({ attachment, analysis: runtimeAnalysis });
    const analysisText = attachmentAnalysisText(attachment, analysis, locale);
    canonicalParts.push(analysisText);
    contentParts.push(analysisText);
    const images = analysis.type === 'image' ? [analysis] : analysis.type === 'pdf' && Array.isArray(analysis.pages)
      ? analysis.pages.filter(isRecord).filter(page => page.requiresVision) : [];
    if (options.summarizeImages) for (const image of images) {
      const imageAttachment = { ...attachment, originalName: image.pageNumber
        ? `${attachment.originalName} · ${String(image.pageNumber)}` : attachment.originalName };
      const text = typeof image.visionSummary === 'string'
        ? attachmentVisionSummaryText(imageAttachment, image.visionSummary, locale)
        : attachmentVisionUnavailableText(imageAttachment, locale);
      canonicalParts.push(text);
      contentParts.push(text);
    }
  }

  return {
    content: contentParts.join('\n\n'),
    canonicalMessage: canonicalParts.join('\n\n'),
    attachmentAnalyses,
  };
}

export async function buildInitialHumanMessageContent(
  message: string,
  attachments: AttachmentInfo[] | undefined,
  locale: AppLocale,
  workspaceRoot: string,
): Promise<string | HumanMessageContentBlock[]> {
  return (await buildInitialHumanMessagePayload(message, attachments, locale, workspaceRoot)).content;
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let singleton: LangGraphAgentService | undefined;

export function getAgentService(): LangGraphAgentService {
  if (!singleton) {
    singleton = new LangGraphAgentService(new AgentSkillRuntime({
      workspaceSkillRoot: getWorkspaceSkillRoot(),
    }));
  }
  return singleton;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class LangGraphAgentService {
  private readonly sessionLock = new SessionLock();
  readonly skillRuntime: AgentSkillRuntime;
  private readonly checkpointer: FileCheckpointer;
  private readonly workspaceRoot: string;

  // Execution clients (created once, injected via config.configurable)
  private readonly engineClient: ReturnType<typeof createLocalAnalysisEngineClient>;
  private readonly codeCheckClient: ReturnType<typeof createLocalCodeCheckClient>;
  private readonly structureProtocolClient: ReturnType<typeof createLocalStructureProtocolClient>;

  // Cached graph — built once, reused across requests
  private graphPromise: Promise<Awaited<ReturnType<typeof buildAgentGraph>>> | undefined;

  constructor(skillRuntime: AgentSkillRuntime) {
    this.skillRuntime = skillRuntime;
    this.checkpointer = new FileCheckpointer(getCheckpointerDataDir());
    this.workspaceRoot = getWorkspaceRoot();

    // Create execution clients once (lifetime of the process)
    this.engineClient = createLocalAnalysisEngineClient();
    this.codeCheckClient = createLocalCodeCheckClient();
    this.structureProtocolClient = createLocalStructureProtocolClient();
  }

  // ---------------------------------------------------------------------------
  // Configurable builder (DI container for tools/nodes)
  // ---------------------------------------------------------------------------

  private buildConfigurable(input?: LangGraphRunInput, traceId?: string, conversationId?: string): AgentConfigurable & { _logger?: unknown } {
    const childLogger = (traceId && conversationId)
      ? createAgentLogger(traceId, conversationId)
      : undefined;
    return {
      skillRuntime: this.skillRuntime,
      engineClient: this.engineClient,
      codeCheckClient: this.codeCheckClient,
      structureProtocolClient: this.structureProtocolClient,
      workspaceRoot: this.workspaceRoot,
      fileAccessAllowlist: input?.context?.restrictFileAccessToAttachments
        ? (input.context.attachments || []).map((attachment) => attachment.relPath)
        : undefined,
      enabledToolIds: input?.context?.enabledToolIds,
      disabledToolIds: input?.context?.disabledToolIds,
      allowShell: getAllowShellTools(),
      maxToolCallsPerTurn: config.agentMaxToolCallsPerTurn,
      summarizeFileImages: (analysis, filePath, signal) => summarizeFileImages(analysis, filePath, input?.context?.locale ?? 'zh', input?.message ?? '', signal),
      _logger: childLogger,
    };
  }

  private buildGraphRuntimeConfig(input?: LangGraphRunInput, traceId?: string, conversationId?: string, runContext?: RunContext) {
    return {
      recursionLimit: getLangGraphRecursionLimit(runContext?.policy.budgets.maxToolCallsPerTurn ?? config.agentMaxToolCallsPerTurn),
      signal: input?.signal,
      configurable: {
        thread_id: conversationId,
        ...this.buildConfigurable(input, traceId, conversationId),
        ...(runContext ? { runContext, maxToolCallsPerTurn: runContext.policy.budgets.maxToolCallsPerTurn,
          enabledToolIds: runContext.policy.activeToolIds, disabledToolIds: [], skillScope: runContext.policy.activeSkillIds } : {}),
      },
    };
  }

  private async prepareRunContext(input: LangGraphRunInput, conversationId: string, resume = false): Promise<RunContext> {
    const graph = await this.getGraph();
    const saved = (await graph.getState({ configurable: { thread_id: conversationId } })).values as AgentState;
    const journalDir = path.join(runtimeBaseDir, 'run-records');
    if (resume && saved.runPolicy && saved.runUsage) {
      return createRunContext(saved.runPolicy, { runId: saved.runUsage.runId, usage: saved.runUsage, journalDir, resume: true });
    }
    const policy = resolveApplicationRunPolicy({ previous: saved.runPolicy ?? undefined, requested: input.context?.runPolicy,
      legacy: { skillIds: input.context?.skillIds ?? (!saved.runPolicy && saved.selectedSkillIds?.length ? saved.selectedSkillIds : undefined),
        enabledToolIds: input.context?.enabledToolIds, disabledToolIds: input.context?.disabledToolIds },
      availableSkillIds: (await this.skillRuntime.listSkillManifests()).map(item => item.id),
    });
    if (policy.routing.mode === 'fixed' && !await this.skillRuntime.resolvePluginForType(policy.routing.skillId, policy.activeSkillIds)) throw new Error('FIXED_SKILL_NOT_A_MODELING_PROVIDER');
    const runtime = createRunContext(policy, { journalDir });
    // An unfinished job outlives a chat turn. Keep its original request reference in
    // the existing ledger until it has entered analysis history; never allocate a new job.
    const previousUsage = saved.runPolicy && saved.runUsage ? readRunUsage(saved.runPolicy, saved.runUsage, journalDir) : null;
    const priorJobs = conversationJobReferences(saved, previousUsage);
    withRunContext(runtime, () => {
      for (const [requestId, reference] of priorJobs) {
        if (reference.inHistory) continue;
        const original = previousUsage?.events.find(event => event.kind === 'analysis_request' && event.requestId === requestId);
        recordRunEvent({ ...original, kind: 'analysis_request', requestId, operation: reference.operation,
          originRunId: original?.originRunId ?? previousUsage?.runId,
          originPolicyHash: original?.originPolicyHash ?? previousUsage?.policyHash });
      }
    });
    // Persist policy and ledger before attachment processing can call a model or interrupt.
    await graph.updateState({ configurable: { thread_id: conversationId } }, { runPolicy: policy, runUsage: snapshotRunUsage(runtime) });
    return runtime;
  }

  // ---------------------------------------------------------------------------
  // Conversation auto-creation
  // ---------------------------------------------------------------------------

  private async ensureConversationRecord(
    conversationId: string | undefined,
    message: string,
  ): Promise<string> {
    if (conversationId) return conversationId;

    const conversation = await prisma.conversation.create({
      data: {
        title: message.slice(0, 50),
        type: 'general',
      },
    });
    return conversation.id;
  }

  // ---------------------------------------------------------------------------
  // Graph construction (cached)
  // ---------------------------------------------------------------------------

  /** Get or build the compiled graph. Thread-safe for concurrent first calls. */
  private async getGraph(): Promise<Awaited<ReturnType<typeof buildAgentGraph>>> {
    if (!this.graphPromise) {
      this.graphPromise = (async () => {
        const skillManifests = await this.skillRuntime.listSkillManifests();
        return await buildAgentGraph({
          skillRuntime: this.skillRuntime,
          skillManifests,
          checkpointer: this.checkpointer,
        });
      })();
    }
    return this.graphPromise;
  }

  /** Force rebuild the graph (e.g. after skill install/uninstall). */
  resetGraph(): void {
    this.graphPromise = undefined;
  }

  private async contextModelUpdate(input: LangGraphRunInput, conversationId: string, evidence: Record<string, unknown>[] = []): Promise<Partial<AgentState>> {
    if (!input.context && !evidence.length) return {};
    const graph = await this.getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversationId } });
    const state = snapshot.values as AgentState;
    if (input.context?.modelRevision !== undefined && input.context.modelRevision !== (state.modelRevision ?? 0)) {
      throw new Error(`MODEL_VERSION_CONFLICT: expected ${state.modelRevision ?? 0}`);
    }
    const update: Partial<AgentState> = {};
    if (input.context?.requestScope) update.requestScope = requestScopeSchema.parse(input.context.requestScope);
    if (input.context?.model) {
      const model = await normalizeEngineeringModel(input.context.model, this.structureProtocolClient, input.context.modelFormat);
      Object.assign(update, commitModel(state, model, 'import_model'));
    }
    if (input.context?.analysisType && input.context.analysisType !== state.policy?.analysisType
      || input.context?.skillIds && JSON.stringify([...input.context.skillIds].sort()) !== JSON.stringify([...(state.selectedSkillIds ?? [])].sort())) {
      Object.assign(update, invalidateAnalysis(state));
    } else if (input.context?.designCode && input.context.designCode !== state.policy?.designCode) {
      Object.assign(update, { codeCheckResult: null, report: null });
    }
    if (evidence.length) Object.assign(update, applyInputEvidence({ ...state, ...update }, evidence));
    return update;
  }

  // ---------------------------------------------------------------------------
  // Streaming entry point
  // ---------------------------------------------------------------------------

  private async assertTurnState(conversationId: string | undefined, resume: boolean): Promise<void> {
    if (!conversationId) return;
    const snapshot = await (await this.getGraph()).getState({ configurable: { thread_id: conversationId } });
    const waiting = clarificationState(snapshot.values as AgentState, snapshot.tasks).waitingForReply;
    if (resume && !waiting) throw new Error('CONVERSATION_NOT_WAITING_FOR_REPLY');
    if (!resume && waiting) throw new Error('CONVERSATION_WAITING_FOR_REPLY: resume the saved turn / 请继续已保存的回合');
  }

  async *runStream(input: LangGraphRunInput): AsyncGenerator<AgentStreamChunk> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { await this.assertTurnState(input.conversationId, false); yield* this.runStreamUnlocked(input); } finally { release(); }
  }

  private async *runStreamUnlocked(input: LangGraphRunInput): AsyncGenerator<AgentStreamChunk> {
    const locale = input.context?.locale || 'zh';
    const conversationId = await this.ensureConversationRecord(
      input.conversationId, input.message,
    );
    const traceId = input.traceId || randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const runtime = await this.prepareRunContext(input, conversationId);
    const config = this.buildGraphRuntimeConfig(input, traceId, conversationId, runtime);

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info({ message: input.message.slice(0, 100) }, 'LangGraph agent stream started');

    const initialPayload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      input.message,
      input.context?.attachments,
      locale,
      this.workspaceRoot,
      { summarizeImages: true, signal: input.signal },
    ));
    const contextSeismicWorkflow = extractContextSeismicWorkflow(input.context, initialPayload.attachmentAnalyses);
    const initialUpdate = await this.contextModelUpdate(input, conversationId,
      initialPayload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis)));
    if (initialUpdate.analysisResult === null) yield { type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true };
    if (initialUpdate.report === null) yield { type: 'artifact_payload_sync', artifact: 'report', invalidated: true };
    const stream = await graph.stream(
      {
        ...initialUpdate,
        runPolicy: runtime.policy, runUsage: snapshotRunUsage(runtime),
        messages: [toInitialHumanMessage(initialPayload.content)],
        locale,
        workspaceRoot: this.workspaceRoot,
        selectedSkillIds: runtime.policy.activeSkillIds,
        toolAccessPolicy: buildToolAccessPolicy(input.context),
        lastUserMessage: initialPayload.canonicalMessage,
        contextSeismicWorkflow,
        policy: {
          analysisType: input.context?.analysisType,
          designCode: input.context?.designCode,
        },
      },
      { ...config, streamMode: ['messages', 'updates', 'custom'] as any },
    );

    const ctx: StreamContext = { conversationId, traceId, startedAt };
    try {
      yield* streamGraphToChunks(stream, ['messages', 'updates', 'custom'], ctx);
    } finally {
      reqLogger.info({ durationMs: Date.now() - reqStart, mode: 'stream' }, 'LangGraph agent stream completed');
    }
  }

  // ---------------------------------------------------------------------------
  // Resume after interrupt
  // ---------------------------------------------------------------------------

  async *resumeStream(
    conversationId: string,
    resumeValue: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamChunk> {
    signal?.throwIfAborted();
    const release = await this.sessionLock.acquire(conversationId);
    try {
      signal?.throwIfAborted();
      await this.assertTurnState(conversationId, true);
      yield* this.resumeStreamUnlocked(conversationId, resumeValue, signal);
    } finally { release(); }
  }

  /** JSON entry point consumes the same checkpoint resumption as Web streaming. */
  async resume(conversationId: string, resumeValue: string, signal?: AbortSignal): Promise<LangGraphRunResult> {
    signal?.throwIfAborted();
    const release = await this.sessionLock.acquire(conversationId);
    try {
      signal?.throwIfAborted();
      await this.assertTurnState(conversationId, true);
      let start: StreamContext | undefined;
      for await (const chunk of this.resumeStreamUnlocked(conversationId, resumeValue, signal)) {
        if (chunk.type === 'start') start = chunk.content as StreamContext;
        if (chunk.type === 'error') throw new Error(chunk.error || 'AGENT_RESUME_FAILED');
      }
      if (!start) throw new Error('AGENT_RESUME_RESULT_MISSING');
      const snapshot = await (await this.getGraph()).getState({ configurable: { thread_id: conversationId } });
      const state = snapshot.values as AgentState;
      const result = this.extractResult(state, conversationId, start.traceId, start.startedAt);
      Object.assign(result, clarificationState(state, snapshot.tasks));
      result.runPolicy = state.runPolicy ?? undefined;
      result.runUsage = state.runPolicy && state.runUsage
        ? readRunUsage(state.runPolicy, state.runUsage, path.join(runtimeBaseDir, 'run-records')) : undefined;
      return result;
    } finally { release(); }
  }

  private async *resumeStreamUnlocked(conversationId: string, resumeValue: string, signal?: AbortSignal): AsyncGenerator<AgentStreamChunk> {
    const traceId = randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const resumedState = (await graph.getState({ configurable: { thread_id: conversationId } })).values as AgentState;
    const resumeInput = { conversationId, message: resumedState.lastUserMessage ?? '', signal, context: { locale: resumedState.locale ?? 'zh' } };
    const runtime = await this.prepareRunContext(resumeInput, conversationId, true);
    const config = this.buildGraphRuntimeConfig(resumeInput, traceId, conversationId, runtime);
    signal?.throwIfAborted();

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info('LangGraph agent resume started');

    const stream = await graph.stream(
      new Command({ resume: resumeValue }),
      { ...config, streamMode: ['messages', 'updates', 'custom'] as any },
    );

    const ctx: StreamContext = { conversationId, traceId, startedAt };
    try {
      yield* streamGraphToChunks(stream, ['messages', 'updates', 'custom'], ctx);
    } finally {
      reqLogger.info({ durationMs: Date.now() - reqStart, mode: 'resume' }, 'LangGraph agent resume completed');
    }
  }

  // ---------------------------------------------------------------------------
  // Synchronous entry point
  // ---------------------------------------------------------------------------

  async run(input: LangGraphRunInput): Promise<LangGraphRunResult> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { await this.assertTurnState(input.conversationId, false); return await this.runUnlocked(input); } finally { release(); }
  }

  private async runUnlocked(input: LangGraphRunInput): Promise<LangGraphRunResult> {
    const locale = input.context?.locale || 'zh';
    const conversationId = await this.ensureConversationRecord(
      input.conversationId, input.message,
    );
    const traceId = input.traceId || randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const runtime = await this.prepareRunContext(input, conversationId);
    const config = this.buildGraphRuntimeConfig(input, traceId, conversationId, runtime);

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info({ message: input.message.slice(0, 100) }, 'LangGraph agent run started');

    const initialPayload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      input.message,
      input.context?.attachments,
      locale,
      this.workspaceRoot,
      { summarizeImages: true, signal: input.signal },
    ));
    const contextSeismicWorkflow = extractContextSeismicWorkflow(input.context, initialPayload.attachmentAnalyses);
    const result = await graph.invoke(
      {
        ...await this.contextModelUpdate(input, conversationId, initialPayload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis))),
        runPolicy: runtime.policy, runUsage: snapshotRunUsage(runtime),
        messages: [toInitialHumanMessage(initialPayload.content)],
        locale,
        workspaceRoot: this.workspaceRoot,
        selectedSkillIds: runtime.policy.activeSkillIds,
        toolAccessPolicy: buildToolAccessPolicy(input.context),
        lastUserMessage: initialPayload.canonicalMessage,
        contextSeismicWorkflow,
        policy: {
          analysisType: input.context?.analysisType,
          designCode: input.context?.designCode,
        },
      },
      config,
    );

    const runResult = this.extractResult(result, conversationId, traceId, startedAt);
    runResult.runPolicy = runtime.policy;
    runResult.runUsage = snapshotRunUsage(runtime);
    reqLogger.info({ durationMs: Date.now() - reqStart, mode: runResult.mode, toolCallCount: runResult.toolCalls.length, success: runResult.success }, 'LangGraph agent run completed');
    return runResult;
  }

  /**
   * Run the agent and return the full final AgentState (not just the summary).
   * Used by integrations that need the full model, analysis and delivery state.
   */
  async runFull(input: LangGraphRunInput): Promise<AgentState> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { await this.assertTurnState(input.conversationId, false); return await this.runFullUnlocked(input); } finally { release(); }
  }

  private async runFullUnlocked(input: LangGraphRunInput): Promise<AgentState> {
    const locale = input.context?.locale || 'zh';
    const conversationId = input.conversationId || `run-${randomUUID()}`;
    const traceId = input.traceId || randomUUID();
    const reqStart = Date.now();
    const graph = await this.getGraph();
    const runtime = await this.prepareRunContext(input, conversationId);
    const config = this.buildGraphRuntimeConfig(input, traceId, conversationId, runtime);

    const reqLogger = createAgentLogger(traceId, conversationId);
    reqLogger.info({ message: input.message.slice(0, 100) }, 'LangGraph agent runFull started');

    const initialPayload = await withRunContext(runtime, () => buildInitialHumanMessagePayload(
      input.message,
      input.context?.attachments,
      locale,
      this.workspaceRoot,
      { summarizeImages: true, signal: input.signal },
    ));
    const contextSeismicWorkflow = extractContextSeismicWorkflow(input.context, initialPayload.attachmentAnalyses);
    const result = await graph.invoke(
      {
        ...await this.contextModelUpdate(input, conversationId, initialPayload.attachmentAnalyses.flatMap(({ analysis }) => collectVisionEvidence(analysis))),
        runPolicy: runtime.policy, runUsage: snapshotRunUsage(runtime),
        messages: [toInitialHumanMessage(initialPayload.content)],
        locale,
        workspaceRoot: this.workspaceRoot,
        selectedSkillIds: runtime.policy.activeSkillIds,
        toolAccessPolicy: buildToolAccessPolicy(input.context),
        lastUserMessage: initialPayload.canonicalMessage,
        contextSeismicWorkflow,
        policy: {
          analysisType: input.context?.analysisType,
          designCode: input.context?.designCode,
        },
      },
      config,
    ) as AgentState;

    reqLogger.info({ durationMs: Date.now() - reqStart, mode: 'full' }, 'LangGraph agent runFull completed');
    return result;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /** Explicit user action: close an idle clarification without running its pending tools. */
  async endWaitingTurn(conversationId: string, expectedRunId: string) {
    // acquire reserves synchronously; no await may separate this check from acquisition.
    if (this.sessionLock.isBusy(conversationId)) throw new Error('CONVERSATION_BUSY');
    const release = await this.sessionLock.acquire(conversationId);
    try {
      const graph = await this.getGraph();
      const graphConfig = { configurable: { thread_id: conversationId } };
      const snapshot = await graph.getState(graphConfig);
      const state = snapshot.values as AgentState;
      if (state.runUsage?.runId !== expectedRunId) throw new Error('CONVERSATION_TURN_CONFLICT');
      if (!clarificationState(state, snapshot.tasks).waitingForReply) throw new Error('CONVERSATION_NOT_WAITING_FOR_REPLY');
      const calls = pendingToolCalls(state);
      if (calls[0]?.name !== 'ask_user_clarification' || calls.some(call => !call.id)) throw new Error('CONVERSATION_WAITING_STATE_INVALID');
      // Verify the durable usage before changing the checkpoint, without rewriting the ledger.
      if (state.runPolicy && state.runUsage) readRunUsage(state.runPolicy, state.runUsage, path.join(runtimeBaseDir, 'run-records'));
      const traceId = randomUUID();
      const completedAt = new Date().toISOString();
      const response = state.locale === 'zh'
        ? '本轮已由你结束。待回复的问题及本批尚未执行的工具已取消；模型、历史结果和本轮用量记录均保留。你可以发送新消息开始下一轮。'
        : 'You ended this turn. The pending question and remaining tools in this batch were cancelled. The model, historical results and usage record are preserved. Send a new message to begin the next turn.';
      const cancelled = calls.map(call => new ToolMessage({ name: call.name, tool_call_id: call.id!, status: 'error',
        content: JSON.stringify({ success: false, status: 'cancelled', errorCode: 'TURN_ENDED_BY_USER',
          message: 'Cancelled by the user without execution / 用户结束本轮，未执行此工具' }) }));
      const ended = new AIMessage({ id: traceId, content: response, additional_kwargs: {
        turnEnd: { runId: expectedRunId, cancelledCallIds: calls.map(call => call.id), completedAt },
      } });
      await graph.updateState(graphConfig, { messages: [...cancelled, ended] }, 'agent');
      const updated = await graph.getState(graphConfig);
      if (updated.next.length || updated.tasks.some(task => task.interrupts?.length)) throw new Error('CONVERSATION_TURN_END_INCOMPLETE');
      const session = await this.getConversationSessionSnapshot(conversationId, state.locale);
      if (!session) throw new Error('CONVERSATION_STATE_UNAVAILABLE');
      return { traceId, completedAt, response,
        userMessage: state.locale === 'zh' ? '结束本轮' : 'End this turn',
        state: updated.values as AgentState,
        runtime: { ...session.snapshot.runtime as ConversationRuntimeSnapshot, busy: false },
      };
    } finally { release(); }
  }

  private async currentJobTools(state: AgentState): Promise<string[]> {
    if (!state.runPolicy) return [];
    // Recheck current server limits without changing the saved policy or its usage ledger.
    const policy = resolveApplicationRunPolicy({ previous: state.runPolicy,
      availableSkillIds: (await this.skillRuntime.listSkillManifests()).map(item => item.id) });
    const configurable = { ...this.buildConfigurable(), enabledToolIds: policy.activeToolIds,
      disabledToolIds: [], runContext: { policy, usage: state.runUsage } } as AgentConfigurable & Record<string, unknown>;
    applyToolsNodeSessionContext(configurable, state);
    return resolveActiveToolIds({ requestedEnabledToolIds: configurable.enabledToolIds,
      requestedDisabledToolIds: configurable.disabledToolIds, allowShell: false }).activeToolIds
      .filter(id => state.runPolicy!.activeToolIds.includes(id));
  }

  private async conversationJobs(state: AgentState, usage: RunUsage | null): Promise<ConversationRuntimeSnapshot['jobs']> {
    const execution = new AnalysisExecutionService();
    let allowed: string[] = [];
    try { allowed = await this.currentJobTools(state); } catch { /* Revoked/removed scope cannot authorize a job action. */ }
    return Promise.all([...conversationJobReferences(state, usage)].map(async ([requestId, reference]) => {
      let receipt: Record<string, unknown>;
      try { receipt = await execution.getRequest(requestId); } catch { receipt = { status: 'outcome_unknown' }; }
      const tool = reference.operation === 'analysis' ? 'run_analysis' : reference.operation === 'native-design' ? 'run_code_check' : null;
      const permitted = Boolean(tool && allowed.includes(tool));
      const matched = !reference.runId || reference.runId === receipt.runId;
      return { requestId, kind: reference.operation, status: String(receipt.status),
        runId: typeof receipt.runId === 'string' ? receipt.runId : null,
        stateHash: typeof receipt.stateHash === 'string' ? receipt.stateHash : undefined,
        ownerAlive: typeof receipt.ownerAlive === 'boolean' ? receipt.ownerAlive : null, inHistory: reference.inHistory,
        cancellationAvailable: matched && permitted && receipt.status === 'running' && receipt.cancellationAvailable === true,
        recoveryAvailable: matched && permitted && allowed.includes('query_results') && !reference.inHistory
          && typeof receipt.runId === 'string' && typeof receipt.stateHash === 'string'
          && (receipt.status === 'completed' || receipt.status === 'outcome_unknown' && receipt.ownerAlive === false) };
    }));
  }

  /** Cancellation deliberately bypasses the long-running chat lock; the service owns the controller. */
  async manageConversationJob(conversationId: string, input: {
    requestId: string; expectedStateHash: string; action: 'cancel' | 'recover';
  }) {
    if (!/^[a-f0-9]{64}$/.test(input.expectedStateHash)) throw new Error('ANALYSIS_REQUEST_STATE_HASH_INVALID');
    const release = input.action === 'recover' ? await this.sessionLock.acquire(conversationId) : undefined;
    try {
      const graph = await this.getGraph();
      const graphConfig = { configurable: { thread_id: conversationId } };
      const state = (await graph.getState(graphConfig)).values as AgentState;
      const usage = state.runPolicy && state.runUsage
        ? readRunUsage(state.runPolicy, state.runUsage, path.join(runtimeBaseDir, 'run-records')) : null;
      const reference = conversationJobReferences(state, usage).get(input.requestId);
      if (!reference) throw new Error('ANALYSIS_REQUEST_OUTSIDE_CONVERSATION');
      const allowed = await this.currentJobTools(state);
      const tool = reference.operation === 'analysis' ? 'run_analysis' : reference.operation === 'native-design' ? 'run_code_check' : null;
      if (!tool || !allowed.includes(tool) || input.action === 'recover' && !allowed.includes('query_results')) throw new Error('ANALYSIS_REQUEST_PERMISSION_DENIED');
      const execution = new AnalysisExecutionService();
      let receipt = await execution.getRequest(input.requestId);
      if (receipt.stateHash !== input.expectedStateHash) throw new Error('ANALYSIS_REQUEST_STATE_CHANGED');
      if (reference.runId && reference.runId !== receipt.runId) throw new Error('ANALYSIS_REQUEST_ARCHIVE_MISMATCH');
      if (input.action === 'cancel') {
        if (receipt.status !== 'running' || receipt.cancellationAvailable !== true) throw new Error('ANALYSIS_REQUEST_NOT_OWNED');
        return execution.cancelRequest(input.requestId);
      }
      // A crash after receipt recovery but before checkpoint publication is recoverable without a second solve.
      if (receipt.status !== 'completed') receipt = await execution.recoverRequest(input.requestId, input.expectedStateHash);
      if (typeof receipt.runId !== 'string') throw new Error('ANALYSIS_REQUEST_ARCHIVE_UNAVAILABLE');
      const run = await execution.getRun(receipt.runId);
      if (run.runId !== receipt.runId || run.requestId !== input.requestId || run.requestHash !== receipt.requestHash
        || !['completed', 'incomplete'].includes(String(run.executionStatus))) throw new Error('ANALYSIS_REQUEST_ARCHIVE_MISMATCH');
      // Historical addition only. Pending questions, budgets and current model/results remain unchanged.
      if (!reference.inHistory) await graph.updateState(graphConfig, { analysisRuns: { [receipt.runId]: run } });
      return { requestId: input.requestId, status: 'history_restored', runId: receipt.runId };
    } finally { release?.(); }
  }

  async getConversationSessionSnapshot(
    conversationId: string,
    _locale: AppLocale,
  ): Promise<{ snapshot: Record<string, unknown>; state?: AgentState } | undefined> {
    try {
      const graph = await this.getGraph();
      const config = { configurable: { thread_id: conversationId } };
      const stateSnapshot = await graph.getState(config);
      const state = stateSnapshot.values as AgentState;
      const clarification = clarificationState(state, stateSnapshot.tasks);
      const policy = state.runPolicy ?? null;
      const usage = policy && state.runUsage ? readRunUsage(policy, state.runUsage, path.join(runtimeBaseDir, 'run-records')) : null;
      const jobs = await this.conversationJobs(state, usage);
      const reason = currentAnalysisError(state);
      const runId = typeof state.analysisResult?.runId === 'string' ? state.analysisResult.runId : null;
      const reportMeta = isRecord(state.report?.meta) ? state.report.meta : isRecord(state.report?.json) && isRecord(state.report.json.meta) ? state.report.json.meta : {};
      const reportCurrent = Boolean(state.report && !reason && runId && reportMeta.runId === runId);
      const runtime: ConversationRuntimeSnapshot = { conversationId, busy: this.sessionLock.isBusy(conversationId), ...clarification,
        modelRevision: state.modelRevision ?? 0, modelPending: state.modelPending ?? false, policy,
        usage: usage ? { runId: usage.runId, policyHash: usage.policyHash, toolCalls: usage.toolCalls,
          llmCalls: usage.llmCalls, recoveries: usage.recoveries } : null,
        analysis: { runId, resultKey: typeof state.analysisResult?.selectedResultKey === 'string' ? state.analysisResult.selectedResultKey : null,
          current: !reason, reason: reason ?? null }, report: { current: reportCurrent, runId: reportCurrent ? runId : null }, jobs };

      return {
        snapshot: {
          draft: state.draftState || null,
          requestScope: state.requestScope ?? null,
          interaction: {
            state: clarification.waitingForReply ? 'waiting' : 'ready',
            stage: 'model',
            turnId: conversationId,
          },
          runtime,
          model: state.model ?? undefined,
          modelRevision: state.modelRevision ?? 0,
          modelPending: state.modelPending ?? false,
          updatedAt: new Date().toISOString(),
        },
        state,
      };
    } catch (error) {
      logger.debug({ conversationId, error }, 'Failed to load session snapshot');
      return undefined;
    }
  }

  async clearConversationSession(conversationId: string): Promise<void> {
    const release = await this.sessionLock.acquire(conversationId);
    try { await this.checkpointer.deleteThread(conversationId); } finally { release(); }
  }

  /** Read the same state used by chat; this projection neither starts a turn nor spends a tool call. */
  async getInputReview(conversationId: string) {
    const graph = await this.getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversationId } });
    const state = snapshot.values as AgentState;
    const policy = state.runPolicy ?? resolveApplicationRunPolicy({
      availableSkillIds: (await this.skillRuntime.listSkillManifests()).map(item => item.id),
    });
    const configurable = { ...this.buildConfigurable(), runContext: { policy, usage: state.runUsage } } as AgentConfigurable & Record<string, unknown>;
    applyToolsNodeSessionContext(configurable, { ...state, selectedSkillIds: state.selectedSkillIds ?? [] });
    const allowed = resolveActiveToolIds({ requestedEnabledToolIds: configurable.enabledToolIds,
      requestedDisabledToolIds: configurable.disabledToolIds, allowShell: false }).activeToolIds;
    const inputIssues = unresolvedInputEvidence(state.inputEvidence);
    if (state.model && !inputIssues.length) {
      try { assertInputEvidenceMatchesModel(state.model, state.inputEvidence); }
      catch (error) { inputIssues.push({ field: 'model', reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { conversationId, revisionToken: inputReviewRevision(state), model: state.model ?? null,
      modelRevision: state.modelRevision ?? 0, modelPending: state.modelPending ?? false,
      inputEvidence: state.inputEvidence ?? [], activeEvidenceIds: activeInputEvidence(state.inputEvidence).map(item => item.id),
      inputIssues,
      groundMotionRecords: isRecord(state.contextSeismicWorkflow?.groundMotionSet)
        ? state.contextSeismicWorkflow.groundMotionSet.records ?? [] : [],
      allowedTools: INPUT_REVIEW_TOOLS.filter(id => allowed.includes(id)),
      runUsage: state.runUsage ?? null, waitingForReply: snapshot.tasks.some(task => task.interrupts?.length)
        || Boolean(state.messages?.length && pendingToolCalls(state)[0]?.name === 'ask_user_clarification'),
      analysisCurrent: !currentAnalysisError(state), reportCurrent: Boolean(state.report),
    };
  }

  /** Catalog only: archived numerical data are queried through the same permitted tool path. */
  async getResultReview(conversationId: string) {
    const graph = await this.getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: conversationId } });
    const state = snapshot.values as AgentState;
    const policy = state.runPolicy;
    const configurable = { ...this.buildConfigurable(), runContext: policy ? { policy, usage: state.runUsage } : undefined } as AgentConfigurable & Record<string, unknown>;
    applyToolsNodeSessionContext(configurable, state);
    const allowed = resolveActiveToolIds({ requestedEnabledToolIds: configurable.enabledToolIds,
      requestedDisabledToolIds: configurable.disabledToolIds, allowShell: false }).activeToolIds;
    const runs = { ...(state.analysisRuns ?? {}) };
    if (typeof state.analysisResult?.runId === 'string') runs[state.analysisResult.runId] = state.analysisResult;
    return { conversationId, revisionToken: inputReviewRevision(state), busy: this.sessionLock.isBusy(conversationId),
      currentRunId: !currentAnalysisError(state) ? state.analysisResult?.runId ?? null : null,
      allowedTools: policy ? RESULT_REVIEW_TOOLS.filter(id => allowed.includes(id)) : [],
      nativeDesign: nativeDesignReview(state, policy ? allowed : []),
      runs: Object.values(runs).map(run => resultCatalogEntry(run,
        run.runId === state.analysisResult?.runId && !currentAnalysisError(state))) };
  }

  async invokeResultReviewTool(conversationId: string, input: {
    revisionToken: string; tool: ResultReviewTool; args: Record<string, unknown>; signal?: AbortSignal;
  }) {
    if (!RESULT_REVIEW_TOOLS.includes(input.tool)) throw new Error('RESULT_REVIEW_TOOL_NOT_ALLOWED');
    return this.invokeConversationTool(conversationId, input, 'result');
  }

  /** Deterministic user actions share the chat lock, registered tools and persisted policy ledger. */
  async invokeInputReviewTool(conversationId: string, input: {
    revisionToken: string; tool: InputReviewTool; args: Record<string, unknown>;
    initialContext?: LangGraphRunInput['context']; signal?: AbortSignal;
  }) {
    if (!INPUT_REVIEW_TOOLS.includes(input.tool)) throw new Error('INPUT_REVIEW_TOOL_NOT_ALLOWED');
    return this.invokeConversationTool(conversationId, input, 'input');
  }

  private async invokeConversationTool(conversationId: string, input: {
    revisionToken: string; tool: InputReviewTool | ResultReviewTool; args: Record<string, unknown>;
    initialContext?: LangGraphRunInput['context']; signal?: AbortSignal;
  }, purpose: 'input' | 'result') {
    const release = await this.sessionLock.acquire(conversationId);
    try {
      input.signal?.throwIfAborted();
      const graph = await this.getGraph();
      const graphConfig = { configurable: { thread_id: conversationId } };
      let state = (await graph.getState(graphConfig)).values as AgentState;
      if (input.revisionToken !== inputReviewRevision(state)) throw new Error('INPUT_REVIEW_REVISION_CONFLICT');
      const initialized = Boolean(state.runPolicy && state.runUsage);
      if (purpose === 'result') {
        if (!initialized) throw new Error('CONVERSATION_POLICY_REQUIRED');
        if (input.tool === 'run_code_check') {
          // The result selector may be historical. Design always operates on the current
          // model/run and cannot switch engines, inject a model, or select a historical run.
          if (Object.keys(input.args).some(key => !['designCode', 'provider', 'design'].includes(key))
            || input.args.provider !== 'native') throw new Error('NATIVE_DESIGN_ARGUMENTS_REQUIRED');
          const review = nativeDesignReview(state, ['run_code_check']);
          if (!review.available) throw new Error(String(review.reason));
        } else {
          const selection = input.tool === 'generate_report' && isRecord(input.args.selection) ? input.args.selection : input.args;
          const runId = selection.runId;
          if (typeof runId !== 'string' || (!state.analysisRuns?.[runId] && state.analysisResult?.runId !== runId)) throw new Error('RUN_OUTSIDE_CONVERSATION');
        }
      }
      const request: LangGraphRunInput = { conversationId, message: `${purpose === 'input' ? 'Input review / 输入复核' : 'Result review / 结果查看'}: ${input.tool}`, signal: input.signal,
        context: initialized ? { locale: state.locale } : input.initialContext };
      const runtime = await this.prepareRunContext(request, conversationId, initialized);
      state = (await graph.getState(graphConfig)).values as AgentState;
      if (!initialized) {
        const update = { selectedSkillIds: runtime.policy.activeSkillIds, toolAccessPolicy: buildToolAccessPolicy(input.initialContext),
          locale: input.initialContext?.locale ?? 'zh' as AppLocale, workspaceRoot: this.workspaceRoot };
        await graph.updateState(graphConfig, update);
        state = { ...state, ...update };
      }
      const executionConfig = this.buildGraphRuntimeConfig(request, randomUUID(), conversationId, runtime);
      applyToolsNodeSessionContext(executionConfig.configurable, state);
      const allowed = resolveActiveToolIds({ requestedEnabledToolIds: executionConfig.configurable.enabledToolIds,
        requestedDisabledToolIds: executionConfig.configurable.disabledToolIds, allowShell: false }).activeToolIds;
      if (!allowed.includes(input.tool)) throw new Error(`TOOL_NOT_ALLOWED: ${input.tool}`);
      // A user may add a drawing while the chat is waiting. Only an explicitly supplied,
      // existing upload in this conversation can extend its attachment list; tool scope stays fixed.
      if (initialized && input.tool === 'analyze_file' && typeof input.args.filePath === 'string'
        && Array.isArray(state.toolAccessPolicy?.fileAccessAllowlist)) {
        const requestedPath = resolveUploadPath(input.args.filePath, this.workspaceRoot);
        const alreadyAllowed = state.toolAccessPolicy.fileAccessAllowlist.some(file => resolveUploadPath(file, this.workspaceRoot) === requestedPath);
        if (!alreadyAllowed) {
          const attachment = input.initialContext?.attachments?.find(item => resolveUploadPath(item.relPath, this.workspaceRoot) === requestedPath);
          if (!attachment) throw new Error('INPUT_ATTACHMENT_NOT_SUPPLIED');
          const [actual, uploadDirectory] = await Promise.all([fs.realpath(requestedPath), fs.realpath(path.join(runtimeBaseDir, '.uploads', conversationId))]);
          if (!isPathWithinRoot(actual, uploadDirectory) || !(await fs.stat(actual)).isFile()) throw new Error('INPUT_ATTACHMENT_OUTSIDE_CONVERSATION');
          const toolAccessPolicy = { ...state.toolAccessPolicy, fileAccessAllowlist: [...state.toolAccessPolicy.fileAccessAllowlist, attachment.relPath] };
          await graph.updateState(graphConfig, { toolAccessPolicy });
          state = { ...state, toolAccessPolicy };
          applyToolsNodeSessionContext(executionConfig.configurable, state);
        }
      }
      const tools = createRegisteredTools({ skillRuntime: this.skillRuntime, workspaceRoot: this.workspaceRoot })
        .filter(tool => tool.name === input.tool);
      const callId = `input-review-${randomUUID()}`;
      const actionState = { ...state, ...(state.requestScope && ['run_code_check','generate_report'].includes(input.tool)
        ? {requestScope:{...state.requestScope, ...(input.tool==='run_code_check'?{design:true}:{report:true})}} : {}), lastUserMessage: `${request.message}\n${JSON.stringify(input.args)}`,
        messages: [...(state.messages ?? []), new AIMessage({ content: '', tool_calls: [{ id: callId, name: input.tool, args: input.args }] })] };
      return await withRunContext(runtime, async () => {
        recordRunEvent({ kind: purpose === 'input' ? 'user_input_review' : 'user_result_review', tool: input.tool, callId, args: input.args });
        const command = await executeToolsSequentially(tools, actionState, executionConfig);
        const { messages, ...update } = command.update as Partial<AgentState>;
        // Synthetic calls are not appended to chat: the pending clarification call must stay current.
        // State updates follow LangGraph's normal human-in-the-loop update semantics.
        await graph.updateState(graphConfig, { ...update, runUsage: snapshotRunUsage(runtime) });
        const output = messages?.find(message => message.getType() === 'tool') as ToolMessage | undefined;
        let result: unknown = output?.content;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* plain tool output */ } }
        const failed = (value: unknown) => isRecord(value) && (value.success === false || value.valid === false || Boolean(value.error) || value.status === 'failed');
        return { result, success: output?.status !== 'error' && !failed(result) && !failed(isRecord(result) ? result.result : undefined),
          review: purpose === 'input' ? await this.getInputReview(conversationId) : await this.getResultReview(conversationId) };
      });
    } finally { release(); }
  }

  async listSkills(): Promise<{ skills: SkillManifest[] }> {
    const manifests = await this.skillRuntime.listSkillManifests();
    return { skills: manifests };
  }

  /**
   * Get the agent protocol (tool metadata) as a static method.
   * Keeps name/description route compatibility while sourcing from registry.
   */
  static getProtocol(): {
    tools: Array<{
      name: string;
      description: string;
      displayName: { zh: string; en: string };
      localizedDescription: { zh: string; en: string };
      category: string;
      risk: string;
      defaultEnabled: boolean;
    }>;
  } {
    return {
      tools: listAgentToolDefinitions().map((definition) => ({
        name: definition.id,
        description: definition.description.en,
        displayName: definition.displayName,
        localizedDescription: definition.description,
        category: definition.category,
        risk: definition.risk,
        defaultEnabled: definition.defaultEnabled,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Result extraction
  // ---------------------------------------------------------------------------

  private extractResult(
    finalState: AgentState,
    conversationId: string,
    traceId: string,
    startedAt: string,
  ): LangGraphRunResult {
    const messages = Array.isArray(finalState.messages) ? finalState.messages : [];
    const lastMessage = messages[messages.length - 1];

    let response = '';
    if (lastMessage && 'content' in lastMessage) {
      response = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    }

    const toolCalls: unknown[] = [];
    for (const msg of messages) {
      if (msg && typeof msg === 'object' && 'tool_calls' in msg) {
        const tc = (msg as any).tool_calls;
        if (Array.isArray(tc)) toolCalls.push(...tc);
      }
    }

    return {
      conversationId,
      traceId,
      startedAt,
      completedAt: new Date().toISOString(),
      success: true,
      response,
      ...clarificationState(finalState),
      mode: toolCalls.length > 0 ? 'execution' : 'conversation',
      toolCalls,
      draftState: finalState.draftState ?? undefined,
    };
  }
}
