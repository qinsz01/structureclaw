import type { ConversationRuntimeSnapshot } from '../use-conversation-runtime'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import type { AssistantPresentation, TimelinePhaseGroup, TimelineStepItem, PresentationArtifactState } from '../message-presentation'
import type { SkillDomain, SkillMetadataLike } from '@/lib/skill-normalization'

export type AnalysisType = 'static' | 'dynamic' | 'seismic' | 'nonlinear'

export type PanelTab = 'analysis' | 'report' | 'context'

export type MessageAttachment = {
  fileId: string
  originalName: string
  relPath: string
  size?: number
  mimeType?: string
}

export type Message = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  status?: 'streaming' | 'done' | 'error' | 'aborted'
  timestamp: string
  debugDetails?: MessageDebugDetails
  presentation?: AssistantPresentation
  toolStep?: TimelineStepItem
  toolCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>
  attachments?: MessageAttachment[]
}

export type AgentToolCall = {
  tool: string
  input?: Record<string, unknown>
  status: 'success' | 'error'
  startedAt?: string
  completedAt?: string
  durationMs?: number
  output?: unknown
  error?: string
}

export type MessageDebugDetails = {
  promptSnapshot: string
  skillIds: string[]
  toolIds?: string[]
  routing?: {
    selectedSkillIds: string[]
    structuralSkillId?: string
    analysisSkillId?: string
    analysisSkillIds?: string[]
  }
  responseSummary: string
  plan: string[]
  toolCalls: AgentToolCall[]
}

export type MessageMetadata = {
  debugDetails?: MessageDebugDetails
  status?: 'done' | 'error' | 'aborted'
  traceId?: string
  presentation?: AssistantPresentation
}

export type AgentInteraction = {
  conversationStage?: string
  missingCritical?: string[]
  missingOptional?: string[]
  fallbackSupportNote?: string
  recommendedNextStep?: string
  questions?: Array<{ question?: string; label?: string }>
  pending?: { criticalMissing?: string[]; nonCriticalMissing?: string[] }
  options?: string[]
  resumeRequired?: boolean
}

export type AgentResult = {
  response?: string
  traceId?: string
  success?: boolean
  needsModelInput?: boolean
  plan?: string[]
  toolCalls?: AgentToolCall[]
  interaction?: AgentInteraction
  analysis?: Record<string, unknown>
  codeCheck?: unknown
  report?: {
    summary?: string
    markdown?: string
    json?: Record<string, unknown>
  }
  clarification?: {
    question?: string
    missingFields?: string[]
  }
  model?: Record<string, unknown>
  data?: Record<string, unknown>
  startedAt?: string
  completedAt?: string
  durationMs?: number
  requestedEngineId?: string
  routing?: MessageDebugDetails['routing']
  visualizationHints?: Record<string, unknown>
}

export type StreamPayload =
  | { type: 'start'; content?: { traceId?: string; conversationId?: string; startedAt?: string } }
  | { type: 'token'; content?: string }
  | { type: 'interaction_update'; content?: AgentInteraction }
  | { type: 'presentation_init'; presentation?: AssistantPresentation }
  | { type: 'phase_upsert'; phase?: TimelinePhaseGroup }
  | { type: 'step_upsert'; phaseId?: string; step?: TimelineStepItem }
  | { type: 'artifact_upsert'; artifact?: PresentationArtifactState }
  | { type: 'artifact_payload_sync'; artifact?: 'model' | 'analysis' | 'report'; model?: Record<string, unknown>; latestResult?: AgentResult; snapshot?: VisualizationSnapshot; invalidated?: boolean }
  | { type: 'summary_replace'; summaryText?: string }
  | { type: 'presentation_complete'; completedAt?: string }
  | { type: 'presentation_error'; phase?: string; message?: string }
  | { type: 'result'; content?: AgentResult }
  | { type: 'done' }
  | { type: 'error'; error?: string; code?: string; retriable?: boolean }

export type StreamSession = {
  conversationId: string
  status: 'streaming' | 'completed' | 'aborted'
  abortController: AbortController
  assistantMessageId: string
  reader: ReadableStreamDefaultReader<Uint8Array> | null
}

export type VisualizationHintsPayload = {
  memberUtilizationMap?: Record<string, number>
  bucklingModes?: Array<{ lambda: number; modeShape: Record<string, [number, number, number]> }>
}

export type ConversationSummary = {
  id: string
  title: string
  type?: string
  createdAt?: string
  updatedAt?: string
}

export type AgentSessionSnapshot = {
  runtime?: ConversationRuntimeSnapshot
  draft?: Record<string, unknown>
  resolved?: {
    analysisType?: AnalysisType
    designCode?: string
    autoCodeCheck?: boolean
    includeReport?: boolean
    reportFormat?: 'json' | 'markdown' | 'both'
    reportOutput?: 'inline' | 'file'
  }
  interaction?: AgentInteraction
  model?: Record<string, unknown>
  updatedAt?: number
}

export type ConversationDetail = ConversationSummary & {
  messages?: Array<{ id: string; role: string; content: string; createdAt: string; metadata?: MessageMetadata }>
  session?: AgentSessionSnapshot | null
  snapshots?: {
    modelSnapshot?: VisualizationSnapshot | null
    resultSnapshot?: VisualizationSnapshot | null
    latestResult?: AgentResult | null
    staleStructuralData?: boolean
  } | null
}

export type PersistedConversation = ConversationSummary & {
  messages: Message[]
  modelText?: string
  designCode?: string
  selectedSkillIds?: string[]
  selectedToolIds?: string[]
  hasExplicitSkillSelection?: boolean
  hasExplicitToolSelection?: boolean
  modelSyncMessage?: string
  activePanel?: PanelTab
  latestResult?: AgentResult | null
  modelVisualizationSnapshot?: VisualizationSnapshot | null
  resultVisualizationSnapshot?: VisualizationSnapshot | null
  visualizationSnapshot?: VisualizationSnapshot | null
  staleStructuralData?: boolean
}

export type AgentSkillSummary = SkillMetadataLike & {
  name: { zh?: string; en?: string }
  description: { zh?: string; en?: string }
  structureType?: string
  stages?: string[]
  triggers?: string[]
  domain?: string
}

export type CapabilitySkillSummary = {
  id: string
  domain?: SkillDomain
  runtimeStatus?: 'active' | 'partial' | 'discoverable' | 'reserved'
}

export type ToolCategory = 'modeling' | 'analysis' | 'code-check' | 'report' | 'utility'

export type CapabilityToolSummary = {
  id: string
  category?: ToolCategory
  source?: 'builtin' | 'skill'
  enabledByDefault?: boolean
  requiresTools?: string[]
  displayName?: { zh?: string; en?: string }
  description?: { zh?: string; en?: string }
}

export type CapabilityDomainSummary = {
  domain: SkillDomain
  runtimeStatus?: 'active' | 'partial' | 'discoverable' | 'reserved'
  skillIds?: string[]
}

export type CapabilityMatrixPayload = {
  skills?: CapabilitySkillSummary[]
  tools?: CapabilityToolSummary[]
  domainSummaries?: CapabilityDomainSummary[]
  skillDomainById?: Record<string, SkillDomain>
  enabledToolIdsBySkill?: Record<string, string[]>
  validEngineIdsBySkill?: Record<string, string[]>
  filteredEngineReasonsBySkill?: Record<string, Record<string, string[]>>
  canonicalSkillIdByAlias?: Record<string, string>
  skillAliasesByCanonicalId?: Record<string, string[]>
}

export type ConsoleUiPreferences = {
  historyCollapsed: boolean
}

export type MessageRenderGroup =
  | { type: 'single'; message: Message }
  | { type: 'assistant-execution'; assistant: Message; tools: Message[] }

export type SeismicContextRow = {
  label: string
  value: string
  source?: string
  note?: string
  assumed?: boolean
}

export type UploadedFileAttachment = { fileId: string; originalName: string; relPath: string; size: number; mimeType: string }

export type AnalysisEngineSummary = {
  id: string
  name: string
  available: boolean
  priority: number
  status: string
  unavailableReason?: string
}

export type EngineProbeResult = { passed: boolean; durationMs?: number; error?: string; loading?: boolean }

export type SeismicContextSummary = {
  status: string
  summaryRows: SeismicContextRow[]
  parameterRows: SeismicContextRow[]
}
