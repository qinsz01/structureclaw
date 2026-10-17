import type { AssistantPresentation, TimelinePhaseGroup, TimelineStepItem, PresentationArtifactState } from '../message-presentation'
import type { MessageAttachment, Message, AgentToolCall, MessageDebugDetails } from './types'

export function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

export function normalizeToolCalls(value: unknown): AgentToolCall[] {
  const rawToolCalls = Array.isArray(value) ? value : []
  return rawToolCalls.map((call) => {
    const status: AgentToolCall['status'] = call?.status === 'error' ? 'error' : 'success'
    return {
      tool: typeof call?.tool === 'string' ? call.tool : 'unknown_tool',
      input: toObjectRecord(call?.input),
      status,
      startedAt: typeof call?.startedAt === 'string' ? call.startedAt : undefined,
      completedAt: typeof call?.completedAt === 'string' ? call.completedAt : undefined,
      durationMs: typeof call?.durationMs === 'number' ? call.durationMs : undefined,
      output: call?.output,
      error: typeof call?.error === 'string' ? call.error : undefined,
    }
  })
}

export function parsePersistedAttachments(metadata: unknown): MessageAttachment[] | undefined {
  const metadataRecord = toObjectRecord(metadata)
  const raw = metadataRecord?.attachments
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const result: MessageAttachment[] = []
  for (const item of raw) {
    const rec = toObjectRecord(item)
    if (!rec) continue
    const fileId = typeof rec.fileId === 'string' ? rec.fileId : ''
    const originalName = typeof rec.originalName === 'string' ? rec.originalName : ''
    const relPath = typeof rec.relPath === 'string' ? rec.relPath : ''
    if (!fileId || !originalName || !relPath) continue
    result.push({
      fileId,
      originalName,
      relPath,
      size: typeof rec.size === 'number' ? rec.size : undefined,
      mimeType: typeof rec.mimeType === 'string' ? rec.mimeType : undefined,
    })
  }
  return result.length > 0 ? result : undefined
}

export function parsePersistedDebugDetails(metadata: unknown): MessageDebugDetails | undefined {
  const metadataRecord = toObjectRecord(metadata)
  const debugRecord = toObjectRecord(metadataRecord?.debugDetails)
  if (!debugRecord) {
    return undefined
  }

  const promptSnapshot = typeof debugRecord.promptSnapshot === 'string'
    ? debugRecord.promptSnapshot
    : ''
  const skillIds = Array.isArray(debugRecord.skillIds)
    ? debugRecord.skillIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const toolIds = Array.isArray(debugRecord.toolIds)
    ? debugRecord.toolIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

  const responseSummary = typeof debugRecord.responseSummary === 'string' ? debugRecord.responseSummary : ''
  const plan = Array.isArray(debugRecord.plan) ? debugRecord.plan.filter((item): item is string => typeof item === 'string') : []
  const toolCalls = normalizeToolCalls(debugRecord.toolCalls)
  const routingRecord = toObjectRecord(debugRecord.routing)
  const routing = routingRecord
    ? {
        selectedSkillIds: Array.isArray(routingRecord.selectedSkillIds)
          ? routingRecord.selectedSkillIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : skillIds,
        structuralSkillId: typeof routingRecord.structuralSkillId === 'string' ? routingRecord.structuralSkillId : undefined,
        analysisSkillId: typeof routingRecord.analysisSkillId === 'string' ? routingRecord.analysisSkillId : undefined,
        analysisSkillIds: Array.isArray(routingRecord.analysisSkillIds)
          ? routingRecord.analysisSkillIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : undefined,
      }
    : undefined

  if (!promptSnapshot && skillIds.length === 0 && toolIds.length === 0 && !routing && !responseSummary && plan.length === 0 && toolCalls.length === 0) {
    return undefined
  }

  return {
    promptSnapshot,
    skillIds,
    toolIds,
    routing,
    responseSummary,
    plan,
    toolCalls,
  }
}

export function parsePersistedPresentation(metadata: unknown): AssistantPresentation | undefined {
  const metadataRecord = toObjectRecord(metadata)
  const presentationRecord = toObjectRecord(metadataRecord?.presentation)
  if (!presentationRecord) {
    return undefined
  }

  const status = presentationRecord.status === 'done'
    || presentationRecord.status === 'error'
    || presentationRecord.status === 'aborted'
    || presentationRecord.status === 'streaming'
    ? presentationRecord.status
    : 'done'
  const mode = presentationRecord.mode === 'conversation' ? 'conversation' : 'execution'
  const summaryText = typeof presentationRecord.summaryText === 'string' ? presentationRecord.summaryText : ''
  const traceId = typeof presentationRecord.traceId === 'string' ? presentationRecord.traceId : undefined
  const startedAt = typeof presentationRecord.startedAt === 'string' ? presentationRecord.startedAt : undefined
  const completedAt = typeof presentationRecord.completedAt === 'string' ? presentationRecord.completedAt : undefined
  const errorMessage = typeof presentationRecord.errorMessage === 'string' ? presentationRecord.errorMessage : undefined

  const artifacts = Array.isArray(presentationRecord.artifacts)
    ? presentationRecord.artifacts.filter((item): item is PresentationArtifactState => Boolean(item && typeof item === 'object'))
    : []

  // Only v3 format is supported — use phases if present, otherwise degrade gracefully
  if (presentationRecord.version === 3 && Array.isArray(presentationRecord.phases)) {
    const phases: TimelinePhaseGroup[] = presentationRecord.phases
      .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
      .map((p): TimelinePhaseGroup => ({
        phaseId: typeof p.phaseId === 'string' ? p.phaseId : `phase:${p.phase ?? 'modeling'}`,
        phase: (typeof p.phase === 'string' ? p.phase : 'modeling') as 'understanding' | 'modeling' | 'validation' | 'analysis' | 'report',
        title: typeof p.title === 'string' ? p.title : undefined,
        status: (typeof p.status === 'string' ? p.status : 'done') as 'pending' | 'running' | 'done' | 'error',
        steps: Array.isArray(p.steps) ? p.steps as TimelineStepItem[] : [],
        startedAt: typeof p.startedAt === 'string' ? p.startedAt : undefined,
        completedAt: typeof p.completedAt === 'string' ? p.completedAt : undefined,
      }))
    return {
      version: 3,
      mode,
      status,
      summaryText,
      phases,
      artifacts,
      traceId,
      startedAt,
      completedAt,
      errorMessage,
    }
  }

  // Legacy v1/v2 data — keep summary only, drop incompatible phase data
  return {
    version: 3,
    mode,
    status,
    summaryText,
    phases: [],
    artifacts,
    traceId,
    startedAt,
    completedAt,
    errorMessage,
  }
}

const LEGACY_ABORTED_SUFFIX_PATTERNS = [
  /\n\n---\n\*(?:Stream stopped|已停止)\*$/u,
  /（已停止）$/u,
] as const

export function stripLegacyAbortedSuffix(content: string) {
  return LEGACY_ABORTED_SUFFIX_PATTERNS.reduce((current, pattern) => current.replace(pattern, ''), content)
}

export function mapToolNameToPhase(toolName: string | undefined): 'understanding' | 'modeling' | 'validation' | 'analysis' | 'report' {
  const name = toolName ?? 'unknown'
  if (name.includes('detect') || name.includes('extract') || name.includes('clarification')) return 'understanding'
  if (name.includes('draft') || name.includes('build_model') || name.includes('model')) return 'modeling'
  if (name.includes('validate')) return 'validation'
  if (name.includes('analysis') || name.includes('code_check')) return 'analysis'
  if (name.includes('report')) return 'report'
  return 'understanding'
}

function hasLegacyAbortedSuffix(content: string) {
  return LEGACY_ABORTED_SUFFIX_PATTERNS.some((pattern) => pattern.test(content))
}

export function parsePersistedMessageStatus(metadata: unknown, content: string): Message['status'] {
  const metadataRecord = toObjectRecord(metadata)
  const rawStatus = metadataRecord?.status

  if (rawStatus === 'aborted' || rawStatus === 'error' || rawStatus === 'done') {
    return rawStatus
  }
  if (rawStatus === 'streaming') {
    return 'aborted'
  }
  if (hasLegacyAbortedSuffix(content)) {
    return 'aborted'
  }
  return 'done'
}

export function normalizePersistedMessage(message: Message): Message {
  const normalizedStatus = message.status === 'streaming'
    ? 'aborted'
    : (message.status ?? (hasLegacyAbortedSuffix(message.content) ? 'aborted' : 'done'))
  const normalizedPresentation = message.presentation
    ? {
        ...message.presentation,
        status: message.presentation.status === 'streaming' && normalizedStatus === 'aborted'
          ? 'aborted'
          : message.presentation.status,
        summaryText: message.presentation.summaryText || stripLegacyAbortedSuffix(message.content),
      }
    : undefined

  return {
    ...message,
    content: stripLegacyAbortedSuffix(message.content),
    status: normalizedStatus,
    presentation: normalizedPresentation,
  }
}
