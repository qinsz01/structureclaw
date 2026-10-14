/**
 * LangGraph-based AgentService — the sole agent implementation.
 *
 * Provides streaming, synchronous, and resumption entry points for the
 * LangGraph ReAct agent, plus conversation/session management methods.
 *
 * Dependency injection uses config.configurable (no globalThis).
 * The graph is built once and cached for the process lifetime.
 */
import { HumanMessage } from '@langchain/core/messages';
import { randomUUID } from 'crypto';
import path from 'node:path';
import { AgentSkillRuntime } from '../agent-runtime/index.js';
import type { SkillManifest } from '../agent-runtime/types.js';
import { buildAgentGraph } from './graph.js';
import { FileCheckpointer } from './file-checkpointer.js';
import { streamGraphToChunks, type StreamContext } from './streaming.js';
import type { AgentState, AgentToolAccessPolicy } from './state.js';
import { getAllowShellTools, getCheckpointerDataDir, getWorkspaceRoot, getWorkspaceSkillRoot } from './config.js';
import { config, runtimeBaseDir } from '../config/index.js';
import type { RunPolicyInput, EffectiveRunPolicy } from '../runtime/run-policy.js';
import { resolveApplicationRunPolicy } from '../runtime/policy-settings.js';
import { createRunContext, withRunContext, snapshotRunUsage, type RunContext, type RunUsage } from '../runtime/run-context.js';
import type { AgentStreamChunk } from '../types/agent-stream.js';
import type { AppLocale } from '../services/locale.js';
import { createLocalAnalysisEngineClient } from '../services/analysis-execution.js';
import { createLocalCodeCheckClient } from '../services/code-check-execution.js';
import { createLocalStructureProtocolClient } from '../services/structure-protocol-execution.js';
import { prisma } from '../utils/database.js';
import { Command } from '@langchain/langgraph';
import { logger } from '../utils/logger.js';
import { createAgentLogger } from '../utils/agent-logger.js';
import type { AgentConfigurable } from './configurable.js';
import { listAgentToolDefinitions } from './tool-registry.js';
import { analyzeUploadedFile } from './file-tools.js';
import { summarizeFileImages } from './attachment-vision.js';
import { collectVisionEvidence } from '../engineering/vision-evidence.js';
import { SessionLock } from '../engineering/session-lock.js';
import { applyInputEvidence, commitModel, invalidateAnalysis } from '../engineering/model-state.js';
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
  mode: 'conversation' | 'execution';
  toolCalls: unknown[];
  model?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  report?: Record<string, unknown>;
  draftState?: Record<string, unknown>;
  presentation?: Record<string, unknown>;
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
    ...(Array.isArray(analysis.headers) ? { headers: analysis.headers } : {}),
    rows,
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
      ? row.map(finiteCellNumber).filter((value): value is number => value !== null)
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
          content,
          fileAnalysis: compactAttachmentAnalysisMetadata(analysis),
        });
      }
      continue;
    }
    if (type === 'excel' && isRecord(analysis.sheets)) {
      for (const [sheetName, sheetValue] of Object.entries(analysis.sheets)) {
        if (!isRecord(sheetValue)) continue;
        if (!looksLikeGroundMotionRows(sheetValue)) continue;
        const record = analysisRowsRecord(attachment, sheetValue, sheetName);
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
  const generatedRecords = existingRecords && existingRecords.length > 0
    ? existingRecords
    : groundMotionRecordsFromAttachmentAnalyses(groundMotionAnalyses);

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
  return (type === 'csv' || type === 'text')
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

  async *runStream(input: LangGraphRunInput): AsyncGenerator<AgentStreamChunk> {
    const release = await this.sessionLock.acquire(input.conversationId ?? randomUUID());
    try { yield* this.runStreamUnlocked(input); } finally { release(); }
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
  ): AsyncGenerator<AgentStreamChunk> {
    const release = await this.sessionLock.acquire(conversationId);
    try { yield* this.resumeStreamUnlocked(conversationId, resumeValue); } finally { release(); }
  }

  private async *resumeStreamUnlocked(conversationId: string, resumeValue: string): AsyncGenerator<AgentStreamChunk> {
    const traceId = randomUUID();
    const startedAt = new Date().toISOString();
    const reqStart = Date.now();

    const graph = await this.getGraph();

    const resumedState = (await graph.getState({ configurable: { thread_id: conversationId } })).values as AgentState;
    const resumeInput = { conversationId, message: resumedState.lastUserMessage ?? '', context: { locale: resumedState.locale ?? 'zh' } };
    const runtime = await this.prepareRunContext(resumeInput, conversationId, true);
    const config = this.buildGraphRuntimeConfig(resumeInput, traceId, conversationId, runtime);

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
    try { return await this.runUnlocked(input); } finally { release(); }
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
    try { return await this.runFullUnlocked(input); } finally { release(); }
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

  async getConversationSessionSnapshot(
    conversationId: string,
    _locale: AppLocale,
  ): Promise<{ snapshot: Record<string, unknown>; state?: AgentState } | undefined> {
    try {
      const graph = await this.getGraph();
      const config = { configurable: { thread_id: conversationId } };
      const stateSnapshot = await graph.getState(config);
      const state = stateSnapshot.values as AgentState;

      return {
        snapshot: {
          draft: state.draftState || null,
          interaction: {
            state: 'ready',
            stage: 'model',
            turnId: conversationId,
          },
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
      mode: toolCalls.length > 0 ? 'execution' : 'conversation',
      toolCalls,
      draftState: finalState.draftState ?? undefined,
    };
  }
}
