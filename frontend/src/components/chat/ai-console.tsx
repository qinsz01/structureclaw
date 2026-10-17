'use client'

import dynamic from 'next/dynamic'
import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { RunSettings, type RunPolicyInput } from './run-settings'
import { useConversationRuntime } from './use-conversation-runtime'
import { ResultReviewPanel } from './result-review-panel'
import { InputReviewPanel } from './input-review-panel'
import { normalizeClarificationOptions } from './clarification-options'
import { useStore } from '@/lib/stores/context'
import { MarkdownBody } from './markdown-body'
import { ToolCallCard } from './tool-call-card'
import { LanguageToggle } from '@/components/language-toggle'
import { ThemeToggle } from '@/components/theme-toggle'
import { ArrowUp, Bot, BrainCircuit, Clock3, FileText, Loader2, Maximize2, MessageSquarePlus, Paperclip, PanelLeftClose, PanelLeftOpen, PanelRightOpen, RefreshCw, Settings, Sparkles, Square, Trash2, User, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toast'
import { buildVisualizationSnapshot } from '@/components/visualization/adapter'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import { useI18n } from '@/lib/i18n'
import { MessagePresentationView, reducePresentationEvent, type AssistantPresentation } from './message-presentation'
import { API_BASE } from '@/lib/api-base'
import { ALL_SKILL_DOMAINS, buildSkillNormalizationContext, DEFAULT_CONSOLE_SKILL_IDS } from '@/lib/skill-normalization'
import { cn, formatDate } from '@/lib/utils'
import type { PanelTab, Message, AgentInteraction, AgentResult, StreamPayload, StreamSession, ConversationSummary, ConversationDetail, PersistedConversation, AgentSkillSummary, CapabilityMatrixPayload, ConsoleUiPreferences } from './console/types'
import { saveConversationSnapshotToBackend, saveConversationMessagesToBackend } from './console/backend-sync'
import { normalizeToolCategory, resolveToolLabel } from './console/capabilities'
import { DEFAULT_CONSOLE_UI_PREFERENCES, loadConsoleUiPreferences, saveConsoleUiPreferences, saveConversationArchiveToStorage, loadConversationArchive } from './console/archive-storage'
import { SIDEBAR_LAYOUT_MIN_WIDTH, getIsSidebarLayout } from './console/layout'
import { groupMessagesForRendering, findPreviousUserMessage, createId, buildPromptSnapshot, resolveAbortedAssistantContent, resolveResumeFromMessage, buildMessageDebugDetails, formatDebugPayload, buildInteractionMessage, extractPdfUrl } from './console/message-utils'
import { parsePersistedAttachments, parsePersistedDebugDetails, parsePersistedPresentation, stripLegacyAbortedSuffix, mapToolNameToPhase, parsePersistedMessageStatus } from './console/persisted-messages'
import { normalizeAgentResultPayload, extractAnalysis, extractVisualizationHints, pickPreferredLatestResult, buildVisualizationTitle, buildModelVisualizationTitle, parseModelJson } from './console/result-utils'
import { toModelText, toModelTextFromSnapshot, isStaleVisualizationSnapshot, isStaleStructuralResult, isResultVisualizationSnapshot, pickPreferredResultSnapshot, buildResultSnapshotFromResult, sanitizePersistedConversation } from './console/snapshot-utils'
import { AnalysisPanel } from './console/analysis-panel'

export { extractSummaryStats } from './console/summary-stats'


const StructuralVisualizationModal = dynamic(
  () => import('@/components/visualization/modal').then((mod) => mod.StructuralVisualizationModal),
  { ssr: false }
)






























































































export function AIConsole() {
  const { t, locale } = useI18n()
  const openWorkspaceSettings = useStore((state) => state.openWorkspaceSettings)
  const initialAssistantMessage = useMemo<Message>(() => ({
    id: 'welcome',
    role: 'assistant',
    content: t('welcomeMessage'),
    status: 'done',
    timestamp: new Date().toISOString(),
  }), [t])
  const quickPrompts = useMemo(
    () => [t('quickPrompt1'), t('quickPrompt2'), t('quickPrompt3')],
    [t]
  )
  const [messages, setMessages] = useState<Message[]>([initialAssistantMessage])
  const messagesRef = useRef(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])
  const [input, setInput] = useState('')
  type UploadedFileAttachment = { fileId: string; originalName: string; relPath: string; size: number; mimeType: string }
  const [attachedFiles, setAttachedFiles] = useState<UploadedFileAttachment[]>([])
  const [uploadingCount, setUploadingCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [conversationId, setConversationId] = useState('')
  const [runPolicy, setRunPolicy] = useState<RunPolicyInput>({})
  useEffect(() => { setRunPolicy({}) }, [conversationId])
  const [serverConversations, setServerConversations] = useState<ConversationSummary[]>([])
  const [conversationArchive, setConversationArchive] = useState<Record<string, PersistedConversation>>({})
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')
  const [streamingSessions, setStreamingSessions] = useState<Map<string, StreamSession>>(new Map())
  const streamingSessionsRef = useRef<Map<string, StreamSession>>(new Map())
  const currentPresentationRef = useRef<AssistantPresentation | null>(null)
  const conversationIdRef = useRef(conversationId)
  const submittingRef = useRef(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [endingTurnConversationId, setEndingTurnConversationId] = useState('')
  const sessionRuntime = useConversationRuntime(conversationId, isStreaming)
  const conversationSelectionRef = useRef(0)
  const restoredScopeRef = useRef<{ conversationId: string; skills: string[]; tools: string[] } | null>(null)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  const [errorMessage, setErrorMessage] = useState('')
  const [modelText, setModelText] = useState('')
  const modelEditedRef = useRef(false)
  const modelEditSequenceRef = useRef(0)
  const displayedModelRevisionRef = useRef<number | null>(0)
  const [modelSyncMessage, setModelSyncMessage] = useState('')
  const [availableSkills, setAvailableSkills] = useState<AgentSkillSummary[]>([])
  const [capabilityMatrix, setCapabilityMatrix] = useState<CapabilityMatrixPayload | null>(null)
  const storeSkillIds = useStore((s) => s.capabilitySkillIds)
  const storeToolIds = useStore((s) => s.capabilityToolIds)
  const storeExplicit = useStore((s) => s.capabilityExplicit)
  const setCapabilityPreferences = useStore((s) => s.setCapabilityPreferences)
  const [allEngines, setAllEngines] = useState<Array<{ id: string; name: string; available: boolean; priority: number; status: string; unavailableReason?: string }>>([])

  const [probeResults, setProbeResults] = useState<Record<string, { passed: boolean; durationMs?: number; error?: string; loading?: boolean }>>({})
  const [latestResult, setLatestResult] = useState<AgentResult | null>(null)
  const [latestModelVisualizationSnapshot, setLatestModelVisualizationSnapshot] = useState<VisualizationSnapshot | null>(null)
  const [latestResultVisualizationSnapshot, setLatestResultVisualizationSnapshot] = useState<VisualizationSnapshot | null>(null)
  const [visualizationOpen, setVisualizationOpen] = useState(false)
  const [visualizationSource, setVisualizationSource] = useState<'model' | 'result'>('result')
  const [activePanel, setActivePanel] = useState<PanelTab>('analysis')
  const [pendingDeleteConversationId, setPendingDeleteConversationId] = useState('')
  const [deletingConversationId, setDeletingConversationId] = useState('')
  const [conversationActivityAt, setConversationActivityAt] = useState<Record<string, string>>({})
  const [uiPreferences, setUiPreferences] = useState<ConsoleUiPreferences>(DEFAULT_CONSOLE_UI_PREFERENCES)
  const [uiPreferencesHydrated, setUiPreferencesHydrated] = useState(false)
  const [resultDialogOpen, setResultDialogOpen] = useState(false)
  const [inputReviewOpen, setInputReviewOpen] = useState(false)
  const [resultReviewOpen, setResultReviewOpen] = useState(false)
  const [isSidebarLayout, setIsSidebarLayout] = useState(getIsSidebarLayout)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const shouldStickToBottomRef = useRef(true)
  const capabilityInitializedRef = useRef(false)
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [capabilityMatrixLoaded, setCapabilityMatrixLoaded] = useState(false)
  const [skillsFailed, setSkillsFailed] = useState(false)
  const [capabilityMatrixFailed, setCapabilityMatrixFailed] = useState(false)
  const [catalogRefresh, setCatalogRefresh] = useState(0)
  // 追踪最后有效的结果用于持久化（不会被引擎切换清除）
  const lastValidResultRef = useRef<AgentResult | null>(null)
  const lastValidResultVisualizationRef = useRef<VisualizationSnapshot | null>(null)
  // Interaction option chips from ask_user_clarification
  const [pendingOptions, setPendingOptions] = useState<string[]>([])
  useEffect(() => { setPendingOptions(sessionRuntime.view?.waitingForReply ? normalizeClarificationOptions(sessionRuntime.view.options) : []) }, [sessionRuntime.view, conversationId])
  useEffect(() => {
    if (sessionRuntime.view && !sessionRuntime.view.busy && !modelEditedRef.current && displayedModelRevisionRef.current === null) {
      displayedModelRevisionRef.current = sessionRuntime.view.modelRevision
    }
  }, [sessionRuntime.view])


  const messageRenderGroups = useMemo(() => groupMessagesForRendering(messages), [messages])

  useEffect(() => {
    setUiPreferences(loadConsoleUiPreferences())
    setUiPreferencesHydrated(true)
  }, [])

  useEffect(() => {
    if (!uiPreferencesHydrated) {
      return
    }

    saveConsoleUiPreferences(uiPreferences)
  }, [uiPreferences, uiPreferencesHydrated])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia(`(min-width: ${SIDEBAR_LAYOUT_MIN_WIDTH}px)`)
      : null
    const updateSidebarLayout = () => {
      setIsSidebarLayout(media ? media.matches : window.innerWidth >= SIDEBAR_LAYOUT_MIN_WIDTH)
    }

    updateSidebarLayout()

    if (media) {
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', updateSidebarLayout)
        return () => media.removeEventListener('change', updateSidebarLayout)
      }

      media.addListener(updateSidebarLayout)
      return () => media.removeListener(updateSidebarLayout)
    }

    window.addEventListener('resize', updateSidebarLayout)
    return () => window.removeEventListener('resize', updateSidebarLayout)
  }, [])

  // Streaming session helpers
  function registerStreamSession(session: StreamSession) {
    setStreamingSessions((prev) => new Map(prev).set(session.conversationId, session))
    streamingSessionsRef.current.set(session.conversationId, session)
  }

  function updateStreamSessionStatus(convId: string, status: StreamSession['status']) {
    setStreamingSessions((prev) => {
      const next = new Map(prev)
      const existing = next.get(convId)
      if (existing) next.set(convId, { ...existing, status })
      return next
    })
    const existing = streamingSessionsRef.current.get(convId)
    if (existing) streamingSessionsRef.current.set(convId, { ...existing, status })
  }

  function removeStreamSession(convId: string) {
    setStreamingSessions((prev) => {
      const next = new Map(prev)
      next.delete(convId)
      return next
    })
    streamingSessionsRef.current.delete(convId)
  }

  function stopStream(targetConversationId?: string) {
    const id = targetConversationId || conversationId
    const session = streamingSessionsRef.current.get(id)
    if (session?.status === 'streaming') {
      session.abortController.abort()
      session.reader?.cancel().catch(() => {})
      updateStreamSessionStatus(id, 'aborted')
    }
  }

  // 保持 refs 与最新有效结果同步
  useEffect(() => {
    if (latestResult) {
      lastValidResultRef.current = latestResult
    }
  }, [latestResult])

  useEffect(() => {
    if (latestResultVisualizationSnapshot) {
      lastValidResultVisualizationRef.current = latestResultVisualizationSnapshot
    }
  }, [latestResultVisualizationSnapshot])

  const skillNormalization = useMemo(
    () => buildSkillNormalizationContext(availableSkills, capabilityMatrix),
    [availableSkills, capabilityMatrix]
  )
  const skillDomainById = skillNormalization.skillDomainById

  const selectedSkillIds = useMemo(() => {
    return skillNormalization.normalizeSkillIds(storeSkillIds)
      .filter((skillId) => availableSkills.some((skill) => skill.id === skillId))
  }, [skillNormalization, storeSkillIds, availableSkills])

  const defaultSelectedSkillIds = useMemo(() => {
    const available = new Set(availableSkills.map((skill) => skill.id))
    return DEFAULT_CONSOLE_SKILL_IDS.filter((skillId) => available.has(skillId))
  }, [availableSkills])

  const hasSelectedCodeCheckSkill = useMemo(
    () => selectedSkillIds.some((skillId) => skillDomainById[skillId] === 'code-check'),
    [selectedSkillIds, skillDomainById]
  )

  const availableTools = useMemo(() => {
    const allTools = Array.isArray(capabilityMatrix?.tools) ? capabilityMatrix.tools : []
    return [...allTools].sort((a, b) => {
      const left = resolveToolLabel(a, locale)
      const right = resolveToolLabel(b, locale)
      return left.localeCompare(right)
    })
  }, [capabilityMatrix, locale])

  const selectedToolIds = useMemo(() => {
    const allToolIds = new Set(availableTools.map((tool) => tool.id))
    return storeToolIds.filter((toolId) => allToolIds.has(toolId))
  }, [storeToolIds, availableTools])

  const hasExplicitSkillSelection = storeExplicit
  const hasExplicitToolSelection = storeExplicit

  useEffect(() => {
    const saved = sessionRuntime.view
    if (!saved?.policy || restoredScopeRef.current?.conversationId === saved.conversationId) return
    const { activeSkillIds: skills, activeToolIds: tools } = saved.policy
    setCapabilityPreferences(skills, tools, true)
    restoredScopeRef.current = { conversationId: saved.conversationId, skills, tools }
  }, [sessionRuntime.view, setCapabilityPreferences])

  const loadedModules = useMemo(() => {
    return availableSkills
      .filter((skill) => selectedSkillIds.includes(skill.id))
      .map((skill) => ({
        id: skill.id,
        domain: skillDomainById[skill.id] || 'unknown',
        label: locale === 'zh' ? (skill.name.zh || skill.id) : (skill.name.en || skill.id),
        source: 'local' as const,
      }))
      .sort((a, b) => {
        const domainOrder = new Map(ALL_SKILL_DOMAINS.map((domain, index) => [domain, index]))
        const left = domainOrder.get(a.domain) ?? Number.MAX_SAFE_INTEGER
        const right = domainOrder.get(b.domain) ?? Number.MAX_SAFE_INTEGER
        if (left !== right) {
          return left - right
        }
        return a.label.localeCompare(b.label)
      })
  }, [availableSkills, locale, selectedSkillIds, skillDomainById])

  const loadedTools = useMemo(() => {
    return availableTools
      .filter((tool) => selectedToolIds.includes(tool.id))
      .map((tool) => ({
        id: tool.id,
        category: normalizeToolCategory(tool.category),
        label: resolveToolLabel(tool, locale),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [availableTools, locale, selectedToolIds])

  useEffect(() => {
    setMessages((current) => {
      if (current.length !== 1 || current[0]?.id !== 'welcome') {
        return current
      }
      return [initialAssistantMessage]
    })
  }, [initialAssistantMessage])

  const mergedConversations = useMemo(() => {
    const map = new Map<string, ConversationSummary>()

    serverConversations.forEach((conversation) => {
      map.set(conversation.id, conversation)
    })

    Object.values(conversationArchive).forEach((conversation) => {
      const current = map.get(conversation.id)
      if (!current) {
        map.set(conversation.id, conversation)
        return
      }

      const currentUpdatedAt = current.updatedAt || current.createdAt || ''
      const archiveUpdatedAt = conversation.updatedAt || conversation.createdAt || ''
      if (archiveUpdatedAt > currentUpdatedAt) {
        map.set(conversation.id, { ...current, ...conversation })
      }
    })

    return Array.from(map.values()).sort((a, b) => {
      const left = b.updatedAt || b.createdAt || ''
      const right = a.updatedAt || a.createdAt || ''
      return left.localeCompare(right)
    })
  }, [conversationArchive, serverConversations])

  useEffect(() => {
    const chatScrollElement = chatScrollRef.current
    if (!chatScrollElement) {
      return
    }

    const handleScroll = () => {
      const distanceFromBottom =
        chatScrollElement.scrollHeight - chatScrollElement.scrollTop - chatScrollElement.clientHeight
      shouldStickToBottomRef.current = distanceFromBottom < 48
    }

    handleScroll()
    chatScrollElement.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      chatScrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [])

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return
    }

    const chatScrollElement = chatScrollRef.current
    if (!chatScrollElement) {
      return
    }

    if (typeof chatScrollElement.scrollTo === 'function') {
      chatScrollElement.scrollTo({
        top: chatScrollElement.scrollHeight,
        behavior: isStreaming ? 'auto' : 'smooth',
      })
      return
    }

    chatScrollElement.scrollTop = chatScrollElement.scrollHeight
  }, [messages, isStreaming])

  useEffect(() => {
    setConversationArchive(loadConversationArchive())
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    const savedArchive = saveConversationArchiveToStorage(conversationArchive)
    if (savedArchive !== conversationArchive) {
      setConversationArchive(savedArchive)
    }
  }, [conversationArchive])

  useEffect(() => {
    let active = true

    setSkillsLoaded(false)
    setSkillsFailed(false)
    async function loadSkills() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/agent/skills`)
        if (!response.ok) throw new Error('SKILL_CATALOG_UNAVAILABLE')
        const payload = await response.json()
        const skillsArray = Array.isArray(payload) ? payload : Array.isArray(payload?.skills) ? payload.skills : null
        if (!skillsArray) throw new Error('SKILL_CATALOG_INVALID')
        if (!active) return
        setAvailableSkills(skillsArray as AgentSkillSummary[])
        setSkillsLoaded(true)
      } catch {
        if (active) setSkillsFailed(true)
      }
    }

    void loadSkills()

    return () => {
      active = false
    }
  }, [catalogRefresh])

  useEffect(() => {
    let active = true

    async function loadEngines() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/analysis-engines`)
        if (!response.ok || !active) return
        const payload = await response.json()
        if (!active || !Array.isArray(payload?.engines)) return
        const engines = (payload.engines as Record<string, unknown>[]).map((e) => ({
          id: String(e.id ?? ''),
          name: String(e.name ?? e.id ?? ''),
          available: Boolean(e.available),
          priority: Number(e.priority ?? 0),
          status: String(e.status ?? 'unknown'),
          unavailableReason: typeof e.unavailableReason === 'string' ? e.unavailableReason : undefined,
        }))
        setAllEngines(engines.sort((a, b) => b.priority - a.priority))
      } catch {
        if (active) {
          setAllEngines([])
        }
      }
    }

    loadEngines()
    return () => { active = false }
  }, [])

  const [probePopupOpen, setProbePopupOpen] = useState(false)
  const [probeAllRunning, setProbeAllRunning] = useState(false)
  const probeButtonRef = useRef<HTMLButtonElement>(null)
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)

  async function probeAllEngines() {
    setProbeAllRunning(true)
    setProbePopupOpen(true)
    const initial: typeof probeResults = {}
    allEngines.forEach((e) => { initial[e.id] = { passed: false, loading: true } })
    setProbeResults(initial)

    let active = true

    await Promise.allSettled(
      allEngines.map(async (engine) => {
        try {
          const response = await fetch(`${API_BASE}/api/v1/analysis-engines/${encodeURIComponent(engine.id)}/probe`, { method: 'POST' })
          if (!response.ok) {
            const text = await response.text()
            if (active) setProbeResults((prev) => ({ ...prev, [engine.id]: { passed: false, error: text || `HTTP ${response.status}`, loading: false } }))
            return
          }
          const payload = await response.json()
          if (active) {
            setProbeResults((prev) => ({
              ...prev,
              [engine.id]: {
                passed: Boolean(payload.passed),
                durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
                error: typeof payload.error === 'string' ? payload.error : undefined,
                loading: false,
              },
            }))
          }
        } catch (err) {
          if (active) setProbeResults((prev) => ({ ...prev, [engine.id]: { passed: false, error: String(err), loading: false } }))
        }
      }),
    )

    if (active) setProbeAllRunning(false)
  }

  async function probeSingleEngine(engineId: string) {
    setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, loading: true } }))
    try {
      const response = await fetch(`${API_BASE}/api/v1/analysis-engines/${encodeURIComponent(engineId)}/probe`, { method: 'POST' })
      if (!response.ok) {
        const text = await response.text()
        setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, error: text || `HTTP ${response.status}`, loading: false } }))
        return
      }
      let payload: { passed?: unknown; durationMs?: unknown; error?: unknown }
      try {
        payload = await response.json()
      } catch {
        setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, error: 'Invalid JSON response', loading: false } }))
        return
      }
      setProbeResults((prev) => ({
        ...prev,
        [engineId]: {
          passed: Boolean(payload.passed),
          durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
          error: typeof payload.error === 'string' ? payload.error : undefined,
          loading: false,
        },
      }))
    } catch (err) {
      setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, error: String(err), loading: false } }))
    }
  }


  // One-time initialization: apply defaults if store is empty
  useEffect(() => {
    if (capabilityInitializedRef.current) return
    if (!skillsLoaded || !capabilityMatrixLoaded) return
    capabilityInitializedRef.current = true

    if (!storeExplicit) {
      const defaultToolIds = availableTools.filter((tool) => tool.enabledByDefault).map((tool) => tool.id)
      setCapabilityPreferences(defaultSelectedSkillIds, defaultToolIds, false)
    }
  }, [availableTools, capabilityMatrixLoaded, defaultSelectedSkillIds, setCapabilityPreferences, skillsLoaded, storeExplicit, storeSkillIds, storeToolIds])

  useEffect(() => {
    let active = true

    setCapabilityMatrixLoaded(false)
    setCapabilityMatrixFailed(false)
    async function loadCapabilityMatrix() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/agent/capability-matrix`)
        if (!response.ok) throw new Error('CAPABILITY_CATALOG_UNAVAILABLE')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tools)) throw new Error('CAPABILITY_CATALOG_INVALID')
        if (!active) return
        setCapabilityMatrix(payload as CapabilityMatrixPayload)
        setCapabilityMatrixLoaded(true)
      } catch {
        if (active) setCapabilityMatrixFailed(true)
      }
    }

    void loadCapabilityMatrix()

    return () => {
      active = false
    }
  }, [catalogRefresh])

  useEffect(() => {
    let cancelled = false

    async function fetchConversations() {
      setHistoryLoading(true)
      setHistoryError('')

      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 8000)

      try {
        const response = await fetch(`${API_BASE}/api/v1/chat/conversations`, { signal: controller.signal })
        window.clearTimeout(timeoutId)
        if (!response.ok) {
          throw new Error(`${t('loadConversationFailed')}: HTTP ${response.status}`)
        }
        const payload = await response.json()
        if (!cancelled) {
          setServerConversations(Array.isArray(payload) ? (payload as ConversationSummary[]) : [])
        }
      } catch (error) {
        if (!cancelled) {
          const isAbort =
            (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
            (error instanceof Error && error.name === 'AbortError')
          if (isAbort) {
            setHistoryError(t('conversationsLoadTimeout'))
          } else {
            setHistoryError(error instanceof Error ? error.message : `${t('loadConversationFailed')}.`)
          }
        }
      } finally {
        window.clearTimeout(timeoutId)
        if (!cancelled) {
          setHistoryLoading(false)
        }
      }
    }

    void fetchConversations()

    return () => {
      cancelled = true
    }
  }, [t])

  const parsedComposerModelState = useMemo(() => {
    const result = parseModelJson(modelText, t)
    // Debug logging for model parsing
    if (modelText && result.model) {
      console.log('[AI Console] Parsed model:', {
        hasNodes: 'nodes' in result.model,
        nodesCount: Array.isArray(result.model.nodes) ? result.model.nodes.length : 0,
        hasElements: 'elements' in result.model,
        elementsCount: Array.isArray(result.model.elements) ? result.model.elements.length : 0,
      })
    }
    return result
  }, [modelText, t])
  const parsedComposerModel = parsedComposerModelState.model
  const parsedComposerModelError = parsedComposerModelState.error || ''
  const modelPreviewBaseTitle = useMemo(
    () =>
      messages.find((message) => message.role === 'user')?.content.slice(0, 48)
      || mergedConversations.find((conversation) => conversation.id === conversationId)?.title
      || t('untitledConversation'),
    [conversationId, mergedConversations, messages, t]
  )

  useEffect(() => {
    if (!parsedComposerModel) {
      console.log('[AI Console] Visualization effect: No parsedComposerModel, skipping snapshot')
      return
    }

    const snapshot = buildVisualizationSnapshot({
      title: buildModelVisualizationTitle(modelPreviewBaseTitle, t),
      model: parsedComposerModel,
      mode: 'model-only',
    })
    console.log('[AI Console] Setting model visualization snapshot:', snapshot ? 'success' : 'null')
    setLatestModelVisualizationSnapshot(snapshot)
    // 保存模型快照到后端
    if (snapshot && conversationId) {
      saveConversationSnapshotToBackend(conversationId, {
        modelSnapshot: snapshot,
      })
    }
  }, [conversationId, modelPreviewBaseTitle, parsedComposerModel, t])

  const hasBoundAnalysisRun = Boolean(
    (typeof latestResult?.analysis?.runId === 'string' && latestResult.analysis.runId)
    || sessionRuntime.view?.analysis.runId
  )
  const activeVisualizationSnapshot = useMemo(() => {
    if (visualizationSource === 'model') {
      if (!latestModelVisualizationSnapshot) {
        return null
      }
      return {
        ...latestModelVisualizationSnapshot,
        statusMessage: parsedComposerModelError ? t('visualizationUsingLastValidModel') : latestModelVisualizationSnapshot.statusMessage,
      }
    }
    if (latestResultVisualizationSnapshot) {
      if (hasBoundAnalysisRun) return latestResultVisualizationSnapshot
      return { ...latestResultVisualizationSnapshot, statusMessage: [latestResultVisualizationSnapshot.statusMessage,
        locale === 'zh'
          ? '只读历史展示快照：未绑定当前分析运行，不能作为新校核或报告的计算依据。'
          : 'Read-only historical display snapshot: not bound to a current analysis run; it cannot supply new checks or reports.',
      ].filter(Boolean).join(' ') }
    }
    if (!latestModelVisualizationSnapshot) {
      return null
    }
    return {
      ...latestModelVisualizationSnapshot,
      statusMessage: t('visualizationFallbackToModel'),
    }
  }, [hasBoundAnalysisRun, latestModelVisualizationSnapshot, latestResultVisualizationSnapshot, locale, parsedComposerModelError, t, visualizationSource])

  // Track which conversation IDs have been deleted locally to prevent auto-persist from restoring them
  const deletedConversationIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!conversationId || deletedConversationIdsRef.current.has(conversationId)) {
      return
    }

    setConversationArchive((current) => {
      const nextEntry = sanitizePersistedConversation({
        id: conversationId,
        title:
          current[conversationId]?.title
          || serverConversations.find((conversation) => conversation.id === conversationId)?.title
          || messages.find((message) => message.role === 'user')?.content.slice(0, 48)
          || t('untitledConversation'),
        type: 'general',
        createdAt:
          current[conversationId]?.createdAt
          || serverConversations.find((conversation) => conversation.id === conversationId)?.createdAt
          || new Date().toISOString(),
        updatedAt:
          conversationActivityAt[conversationId]
          || current[conversationId]?.updatedAt
          || serverConversations.find((conversation) => conversation.id === conversationId)?.updatedAt
          || current[conversationId]?.createdAt
          || serverConversations.find((conversation) => conversation.id === conversationId)?.createdAt
          || new Date().toISOString(),
        messages,
        modelText,
        selectedSkillIds,
        selectedToolIds,
        hasExplicitSkillSelection,
        hasExplicitToolSelection,
        modelSyncMessage,
        activePanel,
        latestResult: latestResult ?? current[conversationId]?.latestResult ?? null,
        modelVisualizationSnapshot:
          latestModelVisualizationSnapshot
          ?? current[conversationId]?.modelVisualizationSnapshot
          ?? null,
        resultVisualizationSnapshot:
          latestResultVisualizationSnapshot
          ?? current[conversationId]?.resultVisualizationSnapshot
          ?? current[conversationId]?.visualizationSnapshot
          ?? null,
        visualizationSnapshot:
          latestResultVisualizationSnapshot
          ?? current[conversationId]?.resultVisualizationSnapshot
          ?? current[conversationId]?.visualizationSnapshot
          ?? null,
        staleStructuralData: current[conversationId]?.staleStructuralData ?? false,
      })

      return {
        ...current,
        [conversationId]: nextEntry,
      }
    })
  }, [
    activePanel,
    conversationId,
    latestModelVisualizationSnapshot,
    latestResult,
    latestResultVisualizationSnapshot,
    messages,
    modelSyncMessage,
    modelText,
    selectedSkillIds,
    selectedToolIds,
    hasExplicitSkillSelection,
    hasExplicitToolSelection,
    conversationActivityAt,
    serverConversations,
    t,
  ])

  async function ensureConversation(seedMessage: string) {
    if (conversationId) {
      return conversationId
    }

    const response = await fetch(`${API_BASE}/api/v1/chat/conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: seedMessage.slice(0, 48),
        type: 'general',
        locale,
      }),
    })

    if (!response.ok) {
      throw new Error(`${t('createConversationFailed')}: HTTP ${response.status}`)
    }

    const payload = await response.json()
    if (!payload?.id) {
      throw new Error(t('missingConversationId'))
    }

    const nextConversation: ConversationSummary = {
      id: payload.id as string,
      title: (payload.title as string) || seedMessage.slice(0, 48),
      type: (payload.type as string) || 'general',
      createdAt: payload.createdAt as string | undefined,
      updatedAt: payload.updatedAt as string | undefined,
    }

    setServerConversations((current) => {
      const deduped = current.filter((conversation) => conversation.id !== nextConversation.id)
      return [nextConversation, ...deduped]
    })
    setConversationId(payload.id)
    return payload.id as string
  }

  function markConversationActivity(targetConversationId: string | undefined) {
    if (!targetConversationId) {
      return
    }

    setConversationActivityAt((current) => ({
      ...current,
      [targetConversationId]: new Date().toISOString(),
    }))
  }

  function appendMessageForConversation(targetConvId: string, message: Message) {
    if (targetConvId === conversationIdRef.current) {
      setMessages((current) => [...current, message])
    } else {
      setConversationArchive((current) => {
        const existing = current[targetConvId]
        if (!existing) return current
        return {
          ...current,
          [targetConvId]: {
            ...existing,
            messages: [...existing.messages, message],
          },
        }
      })
    }
  }

  function replaceMessageForConversation(
    targetConvId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) {
    if (targetConvId === conversationIdRef.current) {
      setMessages((current) =>
        current.map((message) => (message.id === messageId ? updater(message) : message))
      )
    } else {
      setConversationArchive((current) => {
        const existing = current[targetConvId]
        if (!existing) return current
        return {
          ...current,
          [targetConvId]: {
            ...existing,
            messages: existing.messages.map((message) =>
              (message.id === messageId ? updater(message) : message)
            ),
          },
        }
      })
    }
  }

  function persistConversationSnapshotsToArchive(
    targetConversationId: string,
    params: {
      latestResult?: AgentResult | null
      modelSnapshot?: VisualizationSnapshot | null
      resultSnapshot?: VisualizationSnapshot | null
    }
  ) {
    if (!targetConversationId) {
      return
    }

    setConversationArchive((current) => {
      const existing = current[targetConversationId]
      const serverConversation = serverConversations.find((conversation) => conversation.id === targetConversationId)
      const resultSnapshot =
        params.resultSnapshot
        ?? existing?.resultVisualizationSnapshot
        ?? existing?.visualizationSnapshot
        ?? null
      const modelSnapshot =
        params.modelSnapshot
        ?? existing?.modelVisualizationSnapshot
        ?? null
      const latestResultValue =
        params.latestResult
        ?? existing?.latestResult
        ?? null

      const nextEntry = sanitizePersistedConversation({
        id: targetConversationId,
        title: existing?.title || serverConversation?.title || t('untitledConversation'),
        type: existing?.type || serverConversation?.type || 'general',
        createdAt: existing?.createdAt || serverConversation?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: existing?.messages || messages,
        modelText: existing?.modelText ?? modelText,
        selectedSkillIds: existing?.selectedSkillIds || selectedSkillIds,
        selectedToolIds: existing?.selectedToolIds || selectedToolIds,
        hasExplicitSkillSelection: existing?.hasExplicitSkillSelection ?? hasExplicitSkillSelection,
        hasExplicitToolSelection: existing?.hasExplicitToolSelection ?? hasExplicitToolSelection,
        modelSyncMessage: existing?.modelSyncMessage || modelSyncMessage,
        activePanel: existing?.activePanel || activePanel,
        latestResult: latestResultValue,
        modelVisualizationSnapshot: modelSnapshot,
        resultVisualizationSnapshot: resultSnapshot,
        visualizationSnapshot: resultSnapshot,
        staleStructuralData: existing?.staleStructuralData ?? false,
      })

      return {
        ...current,
        [targetConversationId]: nextEntry,
      }
    })
  }

  async function handleSelectConversation(nextConversationId: string) {
    if (nextConversationId === conversationId) {
      return
    }

    const selection = ++conversationSelectionRef.current
    setErrorMessage('')
    setVisualizationOpen(false)
    const archived = conversationArchive[nextConversationId]

    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${nextConversationId}?locale=${encodeURIComponent(locale)}`)
      if (!response.ok) {
        throw new Error(`${t('loadConversationFailed')}: HTTP ${response.status}`)
      }

      const payload = await response.json() as ConversationDetail | null
      if (selection !== conversationSelectionRef.current) return
      const backendMessages = Array.isArray(payload?.messages)
        ? (() => {
            // Build a toolCallId → args index from assistant messages so
            // tool-role messages can recover their input parameters.
            const argsByToolCallId = new Map<string, Record<string, unknown>>()
            for (const msg of payload.messages) {
              if (msg.role === 'assistant') {
                const toolCalls = (msg as any).toolCalls as Array<{ id?: string; name: string; args?: Record<string, unknown> }> | undefined
                if (Array.isArray(toolCalls)) {
                  for (const tc of toolCalls) {
                    if (tc.id && tc.args) argsByToolCallId.set(tc.id, tc.args)
                  }
                }
              }
            }

            const mapped = payload.messages.flatMap((message): Message[] => {
            // Handle tool messages — these come from persistConversationWithState
            if (message.role === 'tool') {
              let restoredSkillId: string | undefined
              try {
                const parsed = JSON.parse(message.content)
                if (typeof parsed?.skillId === 'string') restoredSkillId = parsed.skillId
              } catch {}
              const toolCallId = (message as any).toolCallId || message.id
              return [{
                id: message.id,
                role: 'tool' as const,
                content: message.content,
                status: 'done' as const,
                timestamp: message.createdAt,
                toolStep: {
                  id: toolCallId,
                  phase: mapToolNameToPhase((message as any).name || 'unknown'),
                  status: 'done' as const,
                  tool: (message as any).name || 'unknown',
                  title: (message as any).name || 'unknown',
                  skillId: restoredSkillId,
                  args: argsByToolCallId.get(toolCallId),
                  output: message.content,
                  completedAt: message.createdAt,
                },
              }]
            }
            // Handle assistant messages
            if (message.role === 'assistant') {
              const toolCalls = (message as any).toolCalls as Array<{ id?: string; name: string; args?: Record<string, unknown> }> | undefined
              const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0
              const presentation = parsePersistedPresentation(message.metadata)
              const mapped: Message = {
                id: message.id,
                role: 'assistant' as const,
                content: stripLegacyAbortedSuffix(message.content),
                status: parsePersistedMessageStatus(message.metadata, message.content),
                timestamp: message.createdAt,
                debugDetails: parsePersistedDebugDetails(message.metadata),
                presentation,
                ...(hasToolCalls ? { toolCalls } : {}),
              }
              return [mapped]
            }
            // User messages
            return [{
              id: message.id,
              role: 'user' as const,
              content: message.content,
              status: parsePersistedMessageStatus(message.metadata, message.content),
              timestamp: message.createdAt,
              debugDetails: parsePersistedDebugDetails(message.metadata),
              presentation: parsePersistedPresentation(message.metadata),
              attachments: parsePersistedAttachments(message.metadata),
            }]
          })

            // Backend persistConversationWithState writes all messages in a
            // single createMany with explicit createdAt offsets, so the DB
            // already returns them in correct conversational order.
            return mapped
          })()
        : []
      const archivedMessages = archived?.messages || []
      const archiveHasOnlyWelcome =
        archivedMessages.length > 0
        && archivedMessages.every((message) => message.id === 'welcome')

      const nextMessages =
        backendMessages.length > 0
          ? backendMessages
          : archivedMessages.length > 0 && !archiveHasOnlyWelcome
            ? archivedMessages
            : [initialAssistantMessage]
      const session = payload?.session
      const backendSnapshots = payload?.snapshots
      const backendUpdatedAt = payload?.updatedAt || payload?.createdAt || ''
      const archivedUpdatedAt = archived?.updatedAt || archived?.createdAt || ''
      const preferArchiveState = Boolean(archived && archivedUpdatedAt > backendUpdatedAt)
      const nextLatestResult = preferArchiveState
        ? pickPreferredLatestResult(archived?.latestResult, backendSnapshots?.latestResult)
        : pickPreferredLatestResult(backendSnapshots?.latestResult, archived?.latestResult)
      const nextActivePanel = archived?.activePanel || (nextLatestResult?.report?.markdown ? 'report' : 'analysis')
      const nextModelSyncMessage = session?.model ? t('modelSyncFromChat') : (archived?.modelSyncMessage || '')
      const nextModelSnapshot = preferArchiveState
        ? (archived?.modelVisualizationSnapshot ?? backendSnapshots?.modelSnapshot ?? null)
        : (backendSnapshots?.modelSnapshot ?? archived?.modelVisualizationSnapshot ?? null)
      const nextResultSnapshot = preferArchiveState
        ? (archived?.resultVisualizationSnapshot ?? archived?.visualizationSnapshot ?? backendSnapshots?.resultSnapshot ?? null)
        : (backendSnapshots?.resultSnapshot ?? archived?.resultVisualizationSnapshot ?? archived?.visualizationSnapshot ?? null)
      const backendResultSnapshot = backendSnapshots?.resultSnapshot ?? null
      const archivedResultSnapshot = archived?.resultVisualizationSnapshot ?? archived?.visualizationSnapshot ?? null
      const nextResolvedResultSnapshot = pickPreferredResultSnapshot(nextResultSnapshot, pickPreferredResultSnapshot(backendResultSnapshot, archivedResultSnapshot))
      const synthesizedResultSnapshot = buildResultSnapshotFromResult(
        nextLatestResult,
        payload?.title || archived?.title || t('untitledConversation'),
        session?.model || null
      )
      const nextFinalResultSnapshot = pickPreferredResultSnapshot(nextResolvedResultSnapshot, synthesizedResultSnapshot)
      const restoredModelText =
        toModelText(session?.model)
        || archived?.modelText
        || toModelText(nextLatestResult?.model)
        || toModelTextFromSnapshot(nextModelSnapshot)
        || toModelTextFromSnapshot(nextFinalResultSnapshot)
        || ''
      const hasStaleStructuralData =
        isStaleVisualizationSnapshot(nextModelSnapshot)
        || isStaleVisualizationSnapshot(nextFinalResultSnapshot)
        || isStaleStructuralResult(nextLatestResult)
      const authoritativeRuntime = session?.runtime
      const currentAnalysis = authoritativeRuntime ? authoritativeRuntime.analysis.current : true
      const currentReport = authoritativeRuntime ? authoritativeRuntime.report.current : true
      const safeLatestResult = hasStaleStructuralData ? null : nextLatestResult && {
        ...nextLatestResult, ...(!currentAnalysis ? { analysis: undefined, codeCheck: undefined, report: undefined } : {}),
        ...(!currentReport ? { report: undefined } : {}),
      }
      const safeModelSnapshot = hasStaleStructuralData ? null : nextModelSnapshot
      const safeResultSnapshot = hasStaleStructuralData || !currentAnalysis ? null : nextFinalResultSnapshot
      const safeModelText = hasStaleStructuralData ? '' : restoredModelText
      const safeModelSyncMessage = hasStaleStructuralData ? '' : nextModelSyncMessage
      const safeActivePanel = hasStaleStructuralData ? 'analysis' : nextActivePanel

      setConversationId(nextConversationId)
      conversationIdRef.current = nextConversationId
      setPendingOptions(authoritativeRuntime?.waitingForReply ? normalizeClarificationOptions(authoritativeRuntime.options) : [])
      setAttachedFiles([])
      if (authoritativeRuntime?.policy) {
        const { activeSkillIds: skills, activeToolIds: tools } = authoritativeRuntime.policy
        setCapabilityPreferences(skills, tools, true)
        restoredScopeRef.current = { conversationId: nextConversationId, skills, tools }
      } else restoredScopeRef.current = null
      setMessages(nextMessages)
      setModelText(safeModelText)
      modelEditedRef.current = false
      displayedModelRevisionRef.current = authoritativeRuntime?.modelRevision ?? null
      setModelSyncMessage(safeModelSyncMessage)
      setLatestResult(safeLatestResult)
      lastValidResultRef.current = safeLatestResult
      lastValidResultVisualizationRef.current = safeResultSnapshot
      setLatestModelVisualizationSnapshot(safeModelSnapshot)
      setLatestResultVisualizationSnapshot(safeResultSnapshot)
      setActivePanel(safeActivePanel)

      if (hasStaleStructuralData) {
        setConversationArchive((current) => {
          const existing = current[nextConversationId]
          if (!existing) {
            return current
          }
          return {
            ...current,
            [nextConversationId]: sanitizePersistedConversation({
              ...existing,
              modelText: '',
              modelSyncMessage: '',
              activePanel: 'analysis',
              latestResult: null,
              modelVisualizationSnapshot: null,
              resultVisualizationSnapshot: null,
              visualizationSnapshot: null,
              staleStructuralData: true,
            }),
          }
        })
        toast.error(`${t('staleStructuralSessionTitle')}: ${t('staleStructuralSessionBody')}`)
      }
    } catch (error) {
      if (selection !== conversationSelectionRef.current) return
      if (archived) {
        const restoredArchive = sanitizePersistedConversation(archived)
        setConversationId(nextConversationId)
        conversationIdRef.current = nextConversationId
        setPendingOptions([])
        setAttachedFiles([])
        setMessages(restoredArchive.messages.length ? restoredArchive.messages : [initialAssistantMessage])
        setModelText('')
        modelEditedRef.current = false
        displayedModelRevisionRef.current = null
        setModelSyncMessage('')
        const archivedLatestResult = normalizeAgentResultPayload(restoredArchive.latestResult || null)
        const historicalOnly = archivedLatestResult ? { ...archivedLatestResult, analysis: undefined, codeCheck: undefined, report: undefined } : null
        setLatestResult(historicalOnly)
        lastValidResultRef.current = historicalOnly
        lastValidResultVisualizationRef.current = null
        setLatestModelVisualizationSnapshot(restoredArchive.modelVisualizationSnapshot || null)
        setLatestResultVisualizationSnapshot(null)
        setActivePanel('analysis')

        if (restoredArchive.staleStructuralData) {
          toast.error(`${t('staleStructuralSessionTitle')}: ${t('staleStructuralSessionBody')}`)
        }

        return
      }

      setErrorMessage(error instanceof Error ? error.message : `${t('loadConversationFailed')}.`)
    }
  }

  function resetConsoleState() {
    ++conversationSelectionRef.current
    conversationIdRef.current = ''
    setConversationId('')
    setRunPolicy({})
    setPendingOptions([])
    setAttachedFiles([])
    setInput('')
    restoredScopeRef.current = null
    setMessages([initialAssistantMessage])
    setModelText('')
    modelEditedRef.current = false
    displayedModelRevisionRef.current = 0
    setModelSyncMessage('')
    setLatestResult(null)
    lastValidResultRef.current = null
    lastValidResultVisualizationRef.current = null
    setLatestModelVisualizationSnapshot(null)
    setLatestResultVisualizationSnapshot(null)
    setVisualizationOpen(false)
    setVisualizationSource('result')
    setErrorMessage('')
    setActivePanel('analysis')
    setPendingDeleteConversationId('')
  }

  function handleNewConversation() {
    resetConsoleState()
  }

  async function handleEndTurn() {
    const targetId = conversationId
    const expectedRunId = sessionRuntime.view?.usage?.runId
    if (!targetId || isStreaming || submittingRef.current || endingTurnConversationId
      || !expectedRunId || sessionRuntime.view?.busy || !sessionRuntime.view?.waitingForReply) return
    submittingRef.current = true
    setEndingTurnConversationId(targetId)
    setErrorMessage('')
    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${encodeURIComponent(targetId)}/turn/end`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRunId }),
      })
      if (!response.ok) throw new Error(response.status === 409 ? t('endTurnConflict') : `HTTP ${response.status}`)
      await sessionRuntime.refresh(targetId)
    } catch (error) {
      const nextError = `${t('endTurnFailed')} ${error instanceof Error ? error.message : ''}`.trim()
      if (conversationIdRef.current === targetId) setErrorMessage(nextError)
      toast.error(nextError)
    } finally {
      submittingRef.current = false
      setEndingTurnConversationId('')
    }
  }

  async function handleDeleteConversation(targetConversationId: string) {
    if (streamingSessions.get(targetConversationId)?.status === 'streaming' || deletingConversationId || !targetConversationId) {
      return
    }

    setDeletingConversationId(targetConversationId)
    setErrorMessage('')

    try {
      const response = await fetch(`${API_BASE}/api/v1/chat/conversation/${targetConversationId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(`${t('deleteConversationFailed')} HTTP ${response.status}`)
      }

      deletedConversationIdsRef.current.add(targetConversationId)
      const remainingConversations = mergedConversations.filter((conversation) => conversation.id !== targetConversationId)
      setServerConversations((current) => current.filter((conversation) => conversation.id !== targetConversationId))
      setConversationArchive((current) => {
        const next = { ...current }
        delete next[targetConversationId]
        return next
      })
      setConversationActivityAt((current) => {
        const next = { ...current }
        delete next[targetConversationId]
        return next
      })
      setPendingDeleteConversationId('')

      if (targetConversationId === conversationId) {
        const nextConversation = remainingConversations[0]
        if (nextConversation) {
          await handleSelectConversation(nextConversation.id)
        } else {
          resetConsoleState()
        }
      }

      toast.success(t('deleteConversationSucceeded'))
    } catch (error) {
      const nextError = error instanceof Error ? error.message : t('deleteConversationFailed')
      setErrorMessage(nextError)
      toast.error(nextError)
    } finally {
      setDeletingConversationId('')
    }
  }

  function openVisualization(preferredSource: 'model' | 'result') {
    if (preferredSource === 'result' && conversationId && hasBoundAnalysisRun) { setResultDialogOpen(false); setResultReviewOpen(true); return }
    const snapshotTitle =
      mergedConversations.find((conversation) => conversation.id === conversationId)?.title
      || modelPreviewBaseTitle
      || t('untitledConversation')

    let repairedSnapshot: VisualizationSnapshot | null = null
    if (preferredSource === 'result' && latestResult && !isResultVisualizationSnapshot(latestResultVisualizationSnapshot)) {
      const repairedResultSnapshot = buildResultSnapshotFromResult(latestResult, snapshotTitle, parsedComposerModel || null)
      if (repairedResultSnapshot && isResultVisualizationSnapshot(repairedResultSnapshot)) {
        repairedSnapshot = repairedResultSnapshot
        setLatestResultVisualizationSnapshot(repairedResultSnapshot)
        if (conversationId) {
          persistConversationSnapshotsToArchive(conversationId, {
            latestResult,
            resultSnapshot: repairedResultSnapshot,
          })
        }
      }
    }

    const effectiveResultSnapshot =
      repairedSnapshot
      || (latestResult && !isResultVisualizationSnapshot(latestResultVisualizationSnapshot)
        ? buildResultSnapshotFromResult(latestResult, snapshotTitle, parsedComposerModel || null)
        : latestResultVisualizationSnapshot)

    const nextSource =
      preferredSource === 'result'
        ? (isResultVisualizationSnapshot(effectiveResultSnapshot) ? 'result' : 'model')
        : 'model'
    setVisualizationSource(nextSource)
    setVisualizationOpen(Boolean(nextSource === 'result' ? (effectiveResultSnapshot || latestModelVisualizationSnapshot) : latestModelVisualizationSnapshot))
  }

  function applySynchronizedModel(nextModel: Record<string, unknown>, source: 'conversation' | 'tool') {
    modelEditedRef.current = false
    displayedModelRevisionRef.current = null
    const nextText = JSON.stringify(nextModel, null, 2)
    if (nextText !== modelText) {
      setModelText(nextText)
    }
    if (source === 'conversation') {
      setModelSyncMessage(t('modelSyncFromChat'))
      setActivePanel('context')
      setResultDialogOpen(true)
    }
    setErrorMessage('')
  }

  async function handleSubmit(overrideInput?: string) {
    const trimmedInput = (overrideInput ?? input).trim()
    if (!skillsLoaded || !capabilityMatrixLoaded || !trimmedInput || submittingRef.current) {
      return
    }
    submittingRef.current = true

    const parsedModel = parseModelJson(modelText, t)
    if (parsedModel.error) {
      setErrorMessage(parsedModel.error)
      setActivePanel('context')
      setResultDialogOpen(true)
    }
    const contextModel = parsedModel.error ? undefined : parsedModel.model
    const requestedContextModel = modelEditedRef.current ? contextModel : undefined
    const requestedModelRevision = displayedModelRevisionRef.current
    const submittedModelEditSequence = modelEditSequenceRef.current
    const resumeFromMessage = resolveResumeFromMessage(messagesRef.current, trimmedInput)

    const userMessage: Message = {
      id: createId('user'),
      role: 'user',
      content: trimmedInput,
      status: 'done',
      timestamp: new Date().toISOString(),
      attachments: attachedFiles.length > 0
        ? attachedFiles.map((f) => ({
            fileId: f.fileId,
            originalName: f.originalName,
            relPath: f.relPath,
            size: f.size,
            mimeType: f.mimeType,
          }))
        : undefined,
    }

    const assistantMessageId = createId('assistant')
    const assistantSeed = t('assistantSeedAuto')

    currentPresentationRef.current = null
    setErrorMessage('')
    setInput('')
    setAttachedFiles([])
    setVisualizationOpen(false)
    setVisualizationSource('result')
    setModelSyncMessage('')
    // Append user message and assistant seed immediately (before async work)
    setMessages((current) => [...current, userMessage])
    setMessages((current) => [...current, {
      id: assistantMessageId,
      role: 'assistant',
      content: assistantSeed,
      status: 'streaming',
      timestamp: new Date().toISOString(),
    }])
    let receivedResult = false
    let assistantContent = assistantSeed
    let activeConversationId = conversationId
    let shouldBumpConversationActivity = false
    const abortController = new AbortController()
    const traceId = assistantMessageId

    function finalizeStreamingMessage(message: Message, contentFallback: string, presentation: AssistantPresentation | null | undefined): Message {
      if (message.status !== 'streaming') return message
      return {
        ...message,
        content: message.content || contentFallback,
        status: 'done' as const,
        toolStep: message.role === 'tool' && message.toolStep?.status === 'running'
          ? { ...message.toolStep, status: 'done' as const }
          : message.toolStep,
        presentation: message.role === 'tool' ? undefined : (presentation ?? message.presentation),
      }
    }
    setIsStreaming(true)

    // --- Multi-bubble tracking ---
    // currentTextMessageId: the active text assistant message being appended to.
    // Set to '' when a tool call starts (text finalized). Next token creates a new one.
    let currentTextMessageId = assistantMessageId
    // toolMessageIds: maps stepId → messageId for tool bubbles
    const toolMessageIds = new Map<string, string>()
    // turnMessageIds: all message IDs created during this turn (for finalization)
    const turnMessageIds = new Set<string>([assistantMessageId])

    /** Ensure a text assistant message exists for writing. Creates one if needed. */
    const ensureTextMessage = () => {
      if (!currentTextMessageId) {
        currentTextMessageId = createId('assistant')
        turnMessageIds.add(currentTextMessageId)
        appendMessageForConversation(activeConversationId, {
          id: currentTextMessageId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          timestamp: new Date().toISOString(),
        })
      }
    }

    const syncTextPresentation = (
      nextPresentation: AssistantPresentation,
      nextStatus: Message['status'] = nextPresentation.status === 'done'
        ? 'done'
        : nextPresentation.status === 'error'
          ? 'error'
          : nextPresentation.status === 'aborted'
            ? 'aborted'
            : 'streaming',
    ) => {
      currentPresentationRef.current = nextPresentation
      ensureTextMessage()
      replaceMessageForConversation(activeConversationId, currentTextMessageId, (message) => ({
        ...message,
        content: nextPresentation.summaryText || assistantContent,
        status: nextStatus,
        presentation: nextPresentation,
      }))
    }

    const finalizeAbortedTurn = async () => {
      const abortedContent = resolveAbortedAssistantContent(assistantContent, assistantSeed)
      const abortedPresentation = currentPresentationRef.current
        ? {
            ...currentPresentationRef.current,
            status: 'aborted' as const,
            completedAt: currentPresentationRef.current.completedAt || new Date().toISOString(),
            summaryText: currentPresentationRef.current.summaryText || abortedContent,
          }
        : undefined

      // Finalize ALL messages created during this turn
      for (const msgId of turnMessageIds) {
        replaceMessageForConversation(activeConversationId, msgId, (message) => {
          if (message.status !== 'streaming') return message
          return message.role === 'tool'
            ? { ...message, status: 'aborted' as const }
            : {
                ...message,
                content: message.id === currentTextMessageId ? abortedContent : message.content || abortedContent,
                status: 'aborted' as const,
                presentation: abortedPresentation ?? message.presentation,
              }
        })
      }

      if (activeConversationId) {
        await saveConversationMessagesToBackend(activeConversationId, {
          userMessage: trimmedInput,
          assistantContent: abortedContent,
          assistantAborted: true,
          traceId,
          assistantPresentation: abortedPresentation,
        })
      }
    }

    try {
      const nextConversationId = await ensureConversation(trimmedInput)
      activeConversationId = nextConversationId
      // Existing conversations are checked against the checkpoint before choosing resume/new turn.
      const turnRuntime = conversationId ? await sessionRuntime.refresh(nextConversationId) : null
      if (turnRuntime?.busy) throw new Error(locale === 'zh' ? '此会话仍在运行，请等待或停止当前作业。' : 'This conversation is still running. Wait or stop its current operation.')
      if (turnRuntime?.jobs.some(job => job.status === 'outcome_unknown')) {
        throw new Error(locale === 'zh' ? '作业结果尚未确认，请先核查原作业；不会自动重复求解。' : 'A job outcome is unknown. Inspect the original operation before continuing; it will not be reissued automatically.')
      }
      if (requestedContextModel && turnRuntime && requestedModelRevision !== turnRuntime.modelRevision) {
        throw new Error(locale === 'zh' ? '模型版本已变更或尚未确认，请重新打开此会话后再编辑。' : 'The model revision changed or is unconfirmed. Reload this conversation before editing.')
      }

      // Set conversationId immediately so the Stop button appears
      // without waiting for the SSE start event.
      if (nextConversationId !== conversationId) {
        conversationIdRef.current = nextConversationId
        setConversationId(nextConversationId)
      }

      registerStreamSession({
        conversationId: nextConversationId,
        status: 'streaming',
        abortController,
        assistantMessageId,
        reader: null,
      })

      const normalizedSkillIds = skillNormalization.normalizeSkillIds(selectedSkillIds)
      const fallbackDefaultSkillIds = skillNormalization.normalizeSkillIds(
        defaultSelectedSkillIds.length > 0
          ? defaultSelectedSkillIds
          : [...DEFAULT_CONSOLE_SKILL_IDS]
      )
      const effectiveSkillIds = normalizedSkillIds.length > 0
        ? normalizedSkillIds
        : hasExplicitSkillSelection
          ? []
          : fallbackDefaultSkillIds
      const baseEnabledToolIds = selectedToolIds.length > 0
        ? selectedToolIds
        : hasExplicitToolSelection
          ? []
          : undefined
      const restoredScope = restoredScopeRef.current
      const sameIds = (left: string[], right: string[]) => [...left].sort().join('\0') === [...right].sort().join('\0')
      const keepSavedScope = Boolean(turnRuntime?.policy && (!restoredScope || restoredScope.conversationId !== nextConversationId
        || (sameIds(restoredScope.skills, storeSkillIds) && sameIds(restoredScope.tools, storeToolIds))))
      const contextPayload = {
        runPolicy: Object.keys(runPolicy).length ? runPolicy : undefined,
        locale,
        skillIds: keepSavedScope ? undefined : effectiveSkillIds,
        enabledToolIds: keepSavedScope ? undefined : baseEnabledToolIds,
        model: requestedContextModel,
        modelRevision: requestedContextModel ? requestedModelRevision ?? undefined : undefined,
        modelFormat: requestedContextModel ? 'structuremodel-v2' : undefined,
        engineId: undefined,
        autoCodeCheck: hasSelectedCodeCheckSkill || undefined,
        resumeFromMessage,
        attachments: attachedFiles.length > 0
          ? attachedFiles.map((f) => ({ fileId: f.fileId, originalName: f.originalName, relPath: f.relPath, mimeType: f.mimeType }))
          : undefined,
      }
      const promptSnapshot = buildPromptSnapshot(trimmedInput, contextPayload as Record<string, unknown>)
      const debugSkillIds = Array.isArray((contextPayload as Record<string, unknown>).skillIds)
        ? ((contextPayload as Record<string, unknown>).skillIds as string[])
        : []
      const debugToolIds = Array.isArray((contextPayload as Record<string, unknown>).enabledToolIds)
        ? ((contextPayload as Record<string, unknown>).enabledToolIds as string[])
        : []

      // If the LangGraph agent is paused with interrupt(), resume it
      // by calling /stream/resume instead of starting a new /stream
      const isResume = turnRuntime?.waitingForReply === true
      setPendingOptions([])

      const response = isResume
        ? await fetch(`${API_BASE}/api/v1/chat/stream/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: nextConversationId,
              resumeValue: trimmedInput,
            }),
            signal: abortController.signal,
          })
        : await fetch(`${API_BASE}/api/v1/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: trimmedInput,
              conversationId: nextConversationId,
              traceId,
              context: contextPayload,
            }),
            signal: abortController.signal,
          })

      if (!response.ok || !response.body) {
        throw new Error(`${t('requestFailedHttp')}: HTTP ${response.status}`)
      }

      const reader = response.body.getReader()
      // Store reader so stopStream can cancel it directly
      const existingSession = streamingSessionsRef.current.get(nextConversationId)
      if (existingSession) {
        existingSession.reader = reader
      }
      const decoder = new TextDecoder()
      let buffer = ''
      let chatBuffer = ''

      while (true) {
        if (abortController.signal.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''

        for (const part of parts) {
          if (abortController.signal.aborted) break
          const line = part
            .split('\n')
            .map((item) => item.trim())
            .find((item) => item.startsWith('data:'))

          if (!line) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === '[DONE]') continue

          let payload: StreamPayload
          try {
            payload = JSON.parse(raw) as StreamPayload
          } catch {
            continue
          }

          if (payload.type === 'token') {
            const token = typeof payload.content === 'string' ? payload.content : ''
            chatBuffer += token
            assistantContent = chatBuffer || assistantSeed
            ensureTextMessage()
            replaceMessageForConversation(activeConversationId, currentTextMessageId, (message) => ({
              ...message,
              content: assistantContent,
              status: 'streaming',
            }))
          }

          if (payload.type === 'interaction_update') {
            const interactionMessage = buildInteractionMessage(payload, t, locale)
            assistantContent = interactionMessage
            if (currentPresentationRef.current) {
              const existingSummary = currentPresentationRef.current.summaryText || ''
              const combinedSummary = existingSummary
                ? `${existingSummary}\n\n---\n\n${interactionMessage}`
                : interactionMessage
              const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
                type: 'summary_replace',
                summaryText: combinedSummary,
              })
              syncTextPresentation(nextPresentation, 'streaming')
            } else {
              ensureTextMessage()
              replaceMessageForConversation(activeConversationId, currentTextMessageId, (message) => ({
                ...message,
                content: assistantContent,
                status: 'streaming',
              }))
            }
            const interactionOpts = normalizeClarificationOptions((payload.content as AgentInteraction)?.options)
            if (interactionOpts.length > 0 && activeConversationId === conversationIdRef.current) setPendingOptions(interactionOpts)
          }

          // 处理 'start' 类型消息（包含 conversationId）
          if (payload.type === 'start' && payload.content && typeof payload.content === 'object') {
            const { conversationId: newConversationId } = payload.content as { conversationId?: string; startedAt?: string }
            if (newConversationId && (!conversationIdRef.current || activeConversationId === conversationIdRef.current)) {
              setConversationId(newConversationId)
            }
          }

          if (payload.type === 'presentation_init' && payload.presentation) {
            syncTextPresentation(payload.presentation, 'streaming')
          }

          if (payload.type === 'phase_upsert' && payload.phase && currentPresentationRef.current) {
            const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
              type: 'phase_upsert',
              phase: payload.phase,
            })
            syncTextPresentation(nextPresentation, 'streaming')
          }

          if (payload.type === 'step_upsert' && payload.phaseId && payload.step) {
            if (payload.step.status === 'running') {
              const existingToolMsgId = toolMessageIds.get(payload.step.id)

              if (existingToolMsgId) {
                // Duplicate running event — update existing message instead of creating a new one
                replaceMessageForConversation(activeConversationId, existingToolMsgId, (msg) => ({
                  ...msg,
                  toolStep: { ...msg.toolStep!, ...payload.step },
                }))
              } else {
                // Finalize current text message
                if (currentTextMessageId) {
                  replaceMessageForConversation(activeConversationId, currentTextMessageId, (msg) => {
                    if (msg.status !== 'streaming') return msg
                    return { ...msg, status: 'done' as const }
                  })
                  currentTextMessageId = ''
                  chatBuffer = ''  // Reset so next text bubble only contains new tokens
                }
                // Create a new tool message bubble
                const toolMsgId = createId('tool')
                toolMessageIds.set(payload.step.id, toolMsgId)
                turnMessageIds.add(toolMsgId)
                appendMessageForConversation(activeConversationId, {
                  id: toolMsgId,
                  role: 'tool',
                  content: '',
                  status: 'streaming',
                  timestamp: new Date().toISOString(),
                  toolStep: payload.step,
                })
              }
              // Also track in presentation (for data continuity)
              if (currentPresentationRef.current) {
                const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
                  type: 'step_upsert',
                  phaseId: payload.phaseId,
                  step: payload.step,
                })
                currentPresentationRef.current = nextPresentation
              }
            } else {
              // Update existing tool message (done / error)
              const toolMsgId = toolMessageIds.get(payload.step.id)
              if (toolMsgId) {
                replaceMessageForConversation(activeConversationId, toolMsgId, (msg) => ({
                  ...msg,
                  status: (payload.step!.status === 'error' ? 'error' : 'done') as Message['status'],
                  toolStep: { ...msg.toolStep!, ...payload.step },
                }))
              } else {
                if (currentTextMessageId) {
                  replaceMessageForConversation(activeConversationId, currentTextMessageId, (msg) => {
                    if (msg.status !== 'streaming') return msg
                    return { ...msg, status: 'done' as const }
                  })
                  currentTextMessageId = ''
                  chatBuffer = ''
                }

                const completedToolMsgId = createId('tool')
                toolMessageIds.set(payload.step.id, completedToolMsgId)
                turnMessageIds.add(completedToolMsgId)
                appendMessageForConversation(activeConversationId, {
                  id: completedToolMsgId,
                  role: 'tool',
                  content: '',
                  status: (payload.step.status === 'error' ? 'error' : 'done') as Message['status'],
                  timestamp: new Date().toISOString(),
                  toolStep: payload.step,
                })
              }
              // On tool done, create a "thinking" text bubble so the user sees
              // the LLM is still running. The next token will replace this content.
              if (payload.step.status === 'done' && !currentTextMessageId) {
                currentTextMessageId = createId('assistant')
                turnMessageIds.add(currentTextMessageId)
                appendMessageForConversation(activeConversationId, {
                  id: currentTextMessageId,
                  role: 'assistant',
                  content: '',
                  status: 'streaming',
                  timestamp: new Date().toISOString(),
                })
              }
              // Also track in presentation
              if (currentPresentationRef.current) {
                const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
                  type: 'step_upsert',
                  phaseId: payload.phaseId,
                  step: payload.step,
                })
                currentPresentationRef.current = nextPresentation
              }
            }
          }

          if (payload.type === 'artifact_upsert' && payload.artifact && currentPresentationRef.current) {
            const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
              type: 'artifact_upsert',
              artifact: payload.artifact,
            })
            syncTextPresentation(nextPresentation, 'streaming')
          }

          if (payload.type === 'summary_replace' && typeof payload.summaryText === 'string' && currentPresentationRef.current) {
            assistantContent = payload.summaryText
            const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
              type: 'summary_replace',
              summaryText: payload.summaryText,
            })
            syncTextPresentation(nextPresentation, 'streaming')
          }

          if (payload.type === 'presentation_complete' && typeof payload.completedAt === 'string' && currentPresentationRef.current) {
            const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
              type: 'presentation_complete',
              completedAt: payload.completedAt,
            })
            syncTextPresentation(nextPresentation, 'done')
          }

          if (payload.type === 'presentation_error' && payload.phase && payload.message && currentPresentationRef.current) {
            assistantContent = payload.message || assistantContent
            const nextPresentation = reducePresentationEvent(currentPresentationRef.current, {
              type: 'presentation_error',
              phase: payload.phase as 'understanding' | 'modeling' | 'validation' | 'analysis' | 'report',
              message: payload.message,
            })
            syncTextPresentation(nextPresentation, 'error')
          }

          if (payload.type === 'artifact_payload_sync') {
            if (payload.invalidated && activeConversationId === conversationIdRef.current) {
              setLatestResult((current) => current ? {
                ...current,
                ...(payload.artifact === 'analysis' ? { analysis: undefined, codeCheck: undefined, report: undefined } : { report: undefined }),
              } : null)
              if (payload.artifact === 'analysis') setLatestResultVisualizationSnapshot(null)
            }
            if (payload.artifact === 'model' && payload.model) {
              if (activeConversationId === conversationIdRef.current) {
                applySynchronizedModel(payload.model, 'tool')
              }
            }
            if (payload.artifact === 'analysis' && payload.latestResult && activeConversationId === conversationIdRef.current) {
              setLatestResult((current) => ({
                ...(current || {}),
                ...(payload.latestResult || {}),
              }))
            }
            if (payload.artifact === 'report' && payload.latestResult && activeConversationId === conversationIdRef.current) {
              setLatestResult((current) => ({
                ...(current || {}),
                ...(payload.latestResult || {}),
              }))
              setActivePanel(payload.latestResult.report?.markdown ? 'report' : 'analysis')
            }
          }

          if (payload.type === 'result' && payload.content && typeof payload.content === 'object') {
            const result = {
              ...(payload.content as AgentResult),
            }
            const visualizationHints = extractVisualizationHints(result)
            const debugDetails = buildMessageDebugDetails(promptSnapshot, debugSkillIds, debugToolIds, result)
            if (result.model && typeof result.model === 'object' && !Array.isArray(result.model)) {
              if (activeConversationId === conversationIdRef.current) {
                applySynchronizedModel(result.model, result.analysis ? 'tool' : 'conversation')
              }
            }
            const visualizationSnapshot = buildVisualizationSnapshot({
              title: buildVisualizationTitle(result, trimmedInput.slice(0, 48) || t('untitledConversation')),
              model: (result.model && typeof result.model === 'object' && !Array.isArray(result.model) ? result.model : contextModel) ?? null,
              analysis: extractAnalysis(result),
              mode: 'analysis-result',
              memberUtilizationMap: visualizationHints?.memberUtilizationMap,
              bucklingModes: visualizationHints?.bucklingModes,
            })
            const modelSnapshot = buildVisualizationSnapshot({
              title: buildVisualizationTitle(result, trimmedInput.slice(0, 48) || t('untitledConversation')),
              model: (result.model && typeof result.model === 'object' && !Array.isArray(result.model) ? result.model : contextModel) ?? null,
              mode: 'model-only',
            })
            receivedResult = true
            // Only update active conversation state when this is the foreground stream
            if (activeConversationId === conversationIdRef.current) {
              setLatestResult(result)
              setLatestModelVisualizationSnapshot(modelSnapshot)
              setLatestResultVisualizationSnapshot(visualizationSnapshot)
              setActivePanel(result.report?.markdown ? 'report' : 'analysis')
            }
            // Always persist results to archive (for both active and background)
            persistConversationSnapshotsToArchive(activeConversationId, {
              latestResult: result,
              modelSnapshot,
              resultSnapshot: visualizationSnapshot,
            })
            // 保存结果快照到后端（fire-and-forget to avoid blocking the stream loop）
            saveConversationSnapshotToBackend(activeConversationId, {
              modelSnapshot,
              resultSnapshot: visualizationSnapshot,
              latestResult: result,
            }).catch(() => {})
            assistantContent = result.response || result.clarification?.question || t('returnedResult')
            let nextPresentation: AssistantPresentation | null = currentPresentationRef.current
            if (nextPresentation) {
              if (!nextPresentation.summaryText) {
                nextPresentation = reducePresentationEvent(nextPresentation, {
                  type: 'summary_replace',
                  summaryText: assistantContent,
                })
              }
              nextPresentation = reducePresentationEvent(nextPresentation, {
                type: 'presentation_complete',
                completedAt: result.completedAt || new Date().toISOString(),
              })
              currentPresentationRef.current = nextPresentation
            }
            ensureTextMessage()
            replaceMessageForConversation(activeConversationId, currentTextMessageId, (message) => ({
              ...message,
              content: assistantContent,
              status: 'done',
              debugDetails,
              presentation: currentPresentationRef.current ?? message.presentation,
            }))
            shouldBumpConversationActivity = true
          }

          if (payload.type === 'error') {
            let nextError = typeof payload.error === 'string' ? payload.error : t('requestFailed')
            if (payload.code === 'CONTEXT_OVERFLOW') {
              nextError = t('contextOverflowError')
            }
            assistantContent = nextError
            setPendingOptions([])
            if (activeConversationId === conversationIdRef.current) {
              setErrorMessage(nextError)
            }
            ensureTextMessage()
            replaceMessageForConversation(activeConversationId, currentTextMessageId, (message) => ({
              ...message,
              content: assistantContent,
              status: 'error',
              presentation: currentPresentationRef.current ?? message.presentation,
            }))
            shouldBumpConversationActivity = true
          }
        }
      }

      if (abortController.signal.aborted) {
        await finalizeAbortedTurn()
      } else {
        // Finalize all still-streaming messages from this turn
        for (const msgId of turnMessageIds) {
          replaceMessageForConversation(activeConversationId, msgId, (message) =>
            finalizeStreamingMessage(message, assistantSeed, currentPresentationRef.current)
          )
        }
        if (assistantContent !== assistantSeed || receivedResult) {
          shouldBumpConversationActivity = true
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        await finalizeAbortedTurn()
      } else {
        const nextError = error instanceof Error ? error.message : t('requestFailed')

        if ((receivedResult || assistantContent !== assistantSeed) && nextError === 'Failed to fetch') {
          for (const msgId of turnMessageIds) {
            replaceMessageForConversation(activeConversationId, msgId, (message) =>
              finalizeStreamingMessage(message, '', currentPresentationRef.current)
            )
          }
        } else {
          if (activeConversationId === conversationIdRef.current) {
            setErrorMessage(nextError)
          }
          ensureTextMessage()
          replaceMessageForConversation(activeConversationId, currentTextMessageId, (message) => ({
            ...message,
            content: nextError,
            status: 'error',
            presentation: currentPresentationRef.current ?? message.presentation,
          }))
          shouldBumpConversationActivity = Boolean(activeConversationId)
        }
      }
    } finally {
      const confirmedRuntime = activeConversationId
        ? await sessionRuntime.refresh(activeConversationId).catch(() => null) : null
      // A successfully accepted import is no longer an unsaved composer edit.
      // Keep a newer user edit intact, and bind future edits to the confirmed revision.
      if (requestedContextModel && receivedResult && !abortController.signal.aborted
        && activeConversationId === conversationIdRef.current
        && submittedModelEditSequence === modelEditSequenceRef.current && confirmedRuntime) {
        modelEditedRef.current = false
        displayedModelRevisionRef.current = confirmedRuntime.modelRevision
      }
      submittingRef.current = false
      setIsStreaming(false)
      if (shouldBumpConversationActivity || abortController.signal.aborted) {
        markConversationActivity(activeConversationId)
      }
      const finalStatus = abortController.signal.aborted ? 'aborted' : 'completed'
      updateStreamSessionStatus(activeConversationId, finalStatus)
      setTimeout(() => removeStreamSession(activeConversationId), 2000)
    }
  }

  const historyCollapsed = uiPreferences.historyCollapsed && isSidebarLayout
  const isIdle = messages.length <= 1

  // ── Composer input (shared between idle and active layouts) ──
  async function handleFileSelect(files: FileList | null) {
    if (!files || files.length === 0) return
    const fileArray = Array.from(files)
    let convId = conversationId
    if (!convId) {
      try {
        convId = await ensureConversation(t('fileUploadConversationSeed'))
      } catch {
        setErrorMessage(t('fileUploadError'))
        return
      }
    }
    setUploadingCount((c) => c + fileArray.length)
    for (const file of fileArray) {
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch(`${API_BASE}/api/v1/files/upload?conversationId=${encodeURIComponent(convId)}`, {
          method: 'POST',
          body: formData,
        })
        const json = await res.json() as { success: boolean; files?: Array<{ fileId: string; originalName: string; relPath: string; size: number; mimeType: string }>; errors?: Array<{ name: string; error: string }> }
        if (!res.ok || !json.success) throw new Error(json.errors?.[0]?.error ?? t('fileUploadError'))
        const uploaded = json.files?.[0]
        if (uploaded) setAttachedFiles((prev) => [...prev, uploaded])
      } catch {
        setErrorMessage(t('fileUploadError'))
      }
    }
    setUploadingCount((c) => c - fileArray.length)
  }

  const composerInput = (
    <div className="rounded-[24px] border border-border/70 bg-background/70 p-2.5 dark:border-white/10 dark:bg-black/20">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.csv,.xlsx,.xls,.png,.jpg,.jpeg,.gif,.webp,.bmp,.dxf,.txt,.at2"
        aria-label={t('attachFile')}
        className="hidden"
        onChange={(e) => { handleFileSelect(e.target.files); e.target.value = '' }}
      />
      {attachedFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-3">
          {attachedFiles.map((f) => (
            <span
              key={f.fileId}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground dark:border-white/10 dark:bg-white/5"
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="max-w-[120px] truncate">{f.originalName}</span>
              <button
                type="button"
                aria-label={t('removeAttachment')}
                className="ml-0.5 rounded-full hover:text-foreground"
                onClick={() => setAttachedFiles((prev) => prev.filter((x) => x.fileId !== f.fileId))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {(skillsFailed || capabilityMatrixFailed) && <div role="alert" className="mx-3 mb-2 text-sm text-amber-700 dark:text-amber-300">
        <p>{t('capabilityCatalogFailed')}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setCatalogRefresh(value => value + 1)}>{t('capabilityCatalogRetry')}</Button>
      </div>}
      <RunSettings value={runPolicy} onChange={setRunPolicy} locale={locale}
        modelingSkills={availableSkills.filter(skill => selectedSkillIds.includes(skill.id) && skillDomainById[skill.id] === 'structure-type')
          .map(skill => ({ id: skill.id, label: skill.name[locale] || skill.id }))}
        disabled={isStreaming || Boolean(sessionRuntime.view?.busy || sessionRuntime.view?.waitingForReply)}
        runtime={sessionRuntime.view} statusError={sessionRuntime.error}
        onRefresh={conversationId ? () => { void sessionRuntime.refresh().catch(() => {}) } : undefined} />
      <Textarea
        ref={composerTextareaRef}
        className="min-h-[96px] resize-none border-0 bg-transparent px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
        placeholder={t('composerPlaceholder')}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handleSubmit()
          }
        }}
      />
      <Separator className="bg-border dark:bg-white/10" />
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="border-border/70 bg-background/70 text-muted-foreground dark:border-white/10 dark:bg-white/5" variant="outline">
            {t('conversationIdShort')} {conversationId ? conversationId.slice(0, 8) : t('notCreated')}
          </Badge>
          {allEngines.length > 0 && (
            <div className="flex items-center gap-1.5">
              {allEngines.map((engine) => {
                const probe = probeResults[engine.id]
                const dotColor = probe
                  ? (probe.loading ? 'bg-amber-400 dark:bg-amber-300' : (probe.passed ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-red-400 dark:bg-red-500'))
                  : 'bg-gray-400 dark:bg-gray-500'
                return (
                  <span
                    key={engine.id}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                    title={probe ? undefined : (engine.unavailableReason || (engine.available ? t('engineStatusAvailable') : t('engineStatusUnavailable')))}
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
                    <span className={probe ? (probe.passed ? '' : 'opacity-50') : 'opacity-60'}>{engine.name}</span>
                  </span>
                )
              })}
              <div className="relative ml-1">
                <button
                  ref={probeButtonRef}
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={probePopupOpen}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-cyan-300/30 hover:text-foreground disabled:opacity-50 dark:border-white/10 dark:bg-white/5"
                  onClick={() => {
                    const hasResults = Object.keys(probeResults).length > 0
                    if (hasResults) {
                      setProbePopupOpen((v) => !v)
                    } else {
                      probeAllEngines()
                    }
                  }}
                  disabled={probeAllRunning}
                >
                  {probeAllRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {t('engineProbeButton')}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="rounded-full text-xs" disabled={!conversationId || isStreaming}
            onClick={() => setInputReviewOpen(true)}>{locale === 'zh' ? '输入与证据' : 'Inputs and evidence'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={!conversationId || isStreaming} onClick={() => setResultReviewOpen(true)}>{locale === 'zh' ? '结果与历史' : 'Results and history'}</Button>
          <Button
            type="button"
            variant="outline"
            className="rounded-full text-xs"
            onClick={() => {
              if (isIdle) {
                setActivePanel('context')
              }
              setResultDialogOpen(true)
            }}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            {isIdle ? t('contextTab') : t('showResults')}
          </Button>
          {streamingSessions.get(conversationId)?.status === 'streaming' ? (
            <Button
              type="button"
              className="rounded-full bg-rose-500 px-5 text-white hover:bg-rose-400"
              onClick={() => stopStream()}
            >
              <Square className="h-4 w-4" />
              {t('stopStreaming')}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('attachFile')}
                title={uploadingCount > 0 ? t('uploadingFile') : t('attachFile')}
                className="rounded-full"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingCount > 0 || submittingRef.current}
              >
                {uploadingCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                className="rounded-full bg-cyan-300 px-5 text-slate-950 hover:bg-cyan-200"
                onClick={() => handleSubmit()}
                disabled={!skillsLoaded || !capabilityMatrixLoaded || !input.trim() || submittingRef.current || Boolean(endingTurnConversationId)}
              >
                <ArrowUp className="h-4 w-4" />
                {t('sendMessage')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )

  const gridCols = historyCollapsed
    ? 'xl:grid-cols-[72px_minmax(0,1fr)] 2xl:grid-cols-[80px_minmax(0,1fr)]'
    : 'xl:grid-cols-[260px_minmax(0,1fr)] 2xl:grid-cols-[280px_minmax(0,1fr)]'

  return (
    <div
      data-testid="console-layout-grid"
      data-history-collapsed={String(historyCollapsed)}
      className={cn(
        'grid h-full min-h-screen xl:min-h-0 xl:overflow-hidden transition-[grid-template-columns] duration-300 ease-in-out',
        gridCols
      )}
    >
      <aside
        data-testid="console-history-panel"
        className={cn(
          'flex h-full flex-col bg-card/95 xl:min-h-0 dark:bg-slate-950/90',
          historyCollapsed ? 'min-h-[220px] items-center px-2 py-4' : 'min-h-[320px]'
        )}
      >
        {historyCollapsed ? (
          <>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-10 w-10 rounded-full text-muted-foreground hover:bg-cyan-300/10 hover:text-foreground"
              aria-label={t('expandHistoryPanel')}
              onClick={() => setUiPreferences((current) => ({ ...current, historyCollapsed: false }))}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
            <button
              type="button"
              className="mt-2 h-9 w-9 rounded-lg overflow-hidden"
              aria-label={t('expandHistoryPanel')}
              onClick={() => setUiPreferences((current) => ({ ...current, historyCollapsed: false }))}
            >
              <img
                src="/logo.png"
                alt=""
                className="h-full w-full object-cover opacity-90"
              />
            </button>
            <Button
              type="button"
              size="icon"
              className="mt-2 h-10 w-10 rounded-full bg-cyan-300 text-slate-950 hover:bg-cyan-200"
              aria-label={t('newConversation')}
              onClick={handleNewConversation}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
            <div className="mt-4 flex flex-1 items-center justify-center">
              <span className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-700/80 dark:text-cyan-200/70 [writing-mode:vertical-rl]">
                StructureClaw
              </span>
            </div>
            <div className="mt-auto pt-3 flex flex-col items-center gap-2">
              <span className="text-[10px] text-muted-foreground text-center leading-tight">
                {loadedModules.length} · {loadedTools.length}
              </span>
              <button
                type="button"
                className="h-9 w-9 rounded-full text-muted-foreground hover:bg-cyan-300/10 hover:text-foreground"
                aria-label={t('sidebarGearAriaLabel')}
                onClick={() => openWorkspaceSettings('general')}
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <img
                    src="/logo.png"
                    alt="StructureClaw"
                    className="h-8 w-8 rounded-lg opacity-90"
                  />
                  <span className="text-xs uppercase tracking-[0.28em] text-cyan-700/80 dark:text-cyan-200/70">StructureClaw</span>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-cyan-300/10 hover:text-foreground"
                  aria-label={t('collapseHistoryPanel')}
                  onClick={() => setUiPreferences((current) => ({ ...current, historyCollapsed: true }))}
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
              </div>
              <Button
                type="button"
                className="mt-4 w-full rounded-full bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                onClick={handleNewConversation}
              >
                <MessageSquarePlus className="h-4 w-4" />
                {t('newConversation')}
              </Button>
            </div>

            <div data-testid="console-history-scroll" className="flex-1 overflow-auto p-3 xl:min-h-0">
              {historyLoading && (
                <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
                  {t('loadingConversations')}
                </div>
              )}

              {!historyLoading && historyError && (
                <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                  {historyError}
                </div>
              )}

              {!historyLoading && mergedConversations.length === 0 && (
                <div className="rounded-2xl border border-dashed border-border/70 bg-background/70 px-4 py-6 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
                  {t('noConversationHistory')}
                </div>
              )}

              <div className="space-y-2">
                {mergedConversations.map((conversation) => {
                  const isActive = conversation.id === conversationId
                  const isPendingDelete = conversation.id === pendingDeleteConversationId
                  const isDeleting = conversation.id === deletingConversationId
                  const archive = conversationArchive[conversation.id]
                  const preview = archive?.messages.findLast((message) => message.role === 'assistant')
                    || archive?.messages.findLast((message) => message.role === 'user')
                  const conversationTimestamp = conversation.updatedAt ?? conversation.createdAt

                  return (
                    <div
                      key={conversation.id}
                      className={cn(
                        'rounded-[22px] border px-4 py-3 transition',
                        isActive
                          ? 'border-cyan-300/40 bg-cyan-300/12 text-foreground dark:text-white'
                          : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/30 hover:bg-accent/10 dark:border-white/10 dark:bg-white/5'
                      )}
                    >
                      {isPendingDelete ? (
                        <div className="space-y-3">
                          <div className="text-sm font-medium text-foreground">{t('deleteConversationConfirm')}</div>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              className="rounded-full bg-rose-500 text-white hover:bg-rose-400"
                              disabled={isDeleting}
                              onClick={() => void handleDeleteConversation(conversation.id)}
                            >
                              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                              {isDeleting ? t('deletingConversation') : t('confirmDeleteConversation')}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="rounded-full"
                              disabled={isDeleting}
                              onClick={() => setPendingDeleteConversationId('')}
                            >
                              {t('cancelDeleteConversation')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => void handleSelectConversation(conversation.id)}
                              className="min-w-0 flex-1 text-left"
                            >
                              <div className="line-clamp-2 text-sm font-medium leading-6">
                                {conversation.title || t('untitledConversation')}
                              </div>
                              {conversationTimestamp && (
                                <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                                  <Clock3 className="h-3.5 w-3.5" />
                                  <span>{formatDate(conversationTimestamp, locale)}</span>
                                  {streamingSessions.get(conversation.id)?.status === 'streaming' && (
                                    <span className="flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                                      <span className="inline-flex h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                                      {t('streamingInProgress')}
                                    </span>
                                  )}
                                </div>
                              )}
                              {preview?.content && (
                                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                                  {preview.content}
                                </p>
                              )}
                            </button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-300"
                              aria-label={t('deleteConversation')}
                              disabled={Boolean(deletingConversationId)}
                              onClick={() => setPendingDeleteConversationId(conversation.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="mt-auto border-t border-border/70 px-5 py-4 dark:border-white/10">
              <button
                type="button"
                className="w-full text-left text-xs text-muted-foreground hover:text-foreground transition"
                onClick={() => openWorkspaceSettings('capabilities')}
              >
                {t('sidebarCapabilitySummary')
                  .replace('{skillCount}', String(loadedModules.length))
                  .replace('{toolCount}', String(loadedTools.length))}
              </button>
              <div className="mt-3">
                <button
                  type="button"
                  className="h-9 w-9 rounded-full text-muted-foreground hover:bg-cyan-300/10 hover:text-foreground"
                  aria-label={t('sidebarGearAriaLabel')}
                  onClick={() => openWorkspaceSettings('general')}
                >
                  <Settings className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        )}
      </aside>

      <div className="flex min-h-0 flex-col xl:min-h-0">
        <div className="flex items-center justify-end gap-1.5 px-3 py-2">
          <LanguageToggle />
          <ThemeToggle />
        </div>

        <section
        data-testid="console-chat-panel"
        className="relative flex h-full flex-col overflow-hidden border-x border-border/50 bg-card/95 xl:min-h-0 dark:border-white/5 dark:bg-slate-950/90"
      >
        {isIdle ? (
          /* ── Idle state: centered welcome + composer ── */
          <div className="flex h-full flex-col items-center justify-center px-4">
            <div className="w-full max-w-3xl flex flex-col items-center gap-8 py-12">
              <div className="flex flex-col items-center gap-3">
                <img
                  src="/logo.png"
                  alt="StructureClaw"
                  className="h-14 w-14 rounded-2xl opacity-90"
                />
                <h1 className="text-2xl font-semibold text-foreground">{t('welcomeHeading')}</h1>
                <p className="text-sm text-muted-foreground text-center max-w-md leading-relaxed">{t('welcomeMessage')}</p>
              </div>
              <div className="w-full grid gap-3 sm:grid-cols-3">
                {quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setInput(prompt)}
                    className="rounded-2xl border border-border/70 bg-background/70 p-4 text-left text-sm text-muted-foreground transition hover:border-cyan-300/40 hover:bg-cyan-300/10 hover:text-foreground dark:border-white/10 dark:bg-white/5 dark:hover:text-white"
                  >
                    <Sparkles className="mb-3 h-4 w-4 text-cyan-500 dark:text-cyan-300" />
                    {prompt}
                  </button>
                ))}
              </div>
              <div className="w-full space-y-3">
                {errorMessage && (
                  <div role="alert" className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                    {errorMessage}
                  </div>
                )}
                {composerInput}
              </div>
            </div>
          </div>
        ) : (
        /* ── Active state: chat messages + composer ── */
        <div className="relative flex h-full min-h-[320px] flex-col xl:min-h-0">
          <div
            ref={chatScrollRef}
            data-testid="console-chat-scroll"
            className="flex-1 overflow-auto px-4 py-4 2xl:px-5 2xl:py-5 xl:min-h-0"
          >
            <div className="flex w-full flex-col gap-4">
              {messages.length === 1 && (
                <div className="grid gap-3 md:grid-cols-3">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => setInput(prompt)}
                      className="rounded-3xl border border-border/70 bg-background/70 p-4 text-left text-sm text-muted-foreground transition hover:border-cyan-300/40 hover:bg-cyan-300/10 hover:text-foreground dark:border-white/10 dark:bg-white/5 dark:hover:text-white"
                    >
                      <Sparkles className="mb-3 h-4 w-4 text-cyan-500 dark:text-cyan-300" />
                      {prompt}
                    </button>
                  ))}
                </div>
              )}

              {messageRenderGroups.map((group, groupIndex) => {
                if (group.type === 'assistant-execution') {
                  const message = group.assistant
                  return (
                    <div key={message.id} data-testid="assistant-execution-group" className="flex justify-start gap-3">
                      <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan-400/15 text-cyan-700 dark:text-cyan-200">
                        <Bot className="h-5 w-5" />
                      </div>
                      <div className="max-w-[88%] space-y-2">
                        <div className="rounded-[26px] border border-border/70 bg-background/70 px-5 py-4 text-foreground shadow-lg dark:border-white/10 dark:bg-white/5">
                          <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                            <BrainCircuit className="h-3.5 w-3.5" />
                            <span>{t('structureClawAi')}</span>
                            <span className="text-slate-500">{formatDate(message.timestamp, locale)}</span>
                          </div>
                          {message.presentation ? (
                            <MessagePresentationView
                              presentation={message.presentation}
                              t={t}
                              resolveSkillName={(skillId: string) => {
                                const skill = availableSkills.find((s) => s.id === skillId)
                                if (!skill) return skillId
                                return locale === 'zh' ? (skill.name.zh || skill.name.en || skillId) : (skill.name.en || skill.name.zh || skillId)
                              }}
                            />
                          ) : message.content ? (
                            <MarkdownBody compact content={message.content} />
                          ) : null}
                          {message.status === 'streaming' && (
                            <span className="inline-flex items-center gap-1.5 mt-1" role="status">
                              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500 dark:bg-cyan-400" />
                              <span className="text-xs text-muted-foreground animate-pulse">{t('streamingInProgress')}</span>
                            </span>
                          )}
                          {message.status === 'aborted' && (
                            <span className="ml-2 inline-flex items-center gap-1 text-xs text-rose-500 dark:text-rose-400">
                              <Square className="h-2.5 w-2.5" />
                              {t('streamAborted')}
                            </span>
                          )}
                          {message.status === 'error' && (
                            <div className="mt-2 flex items-center gap-2">
                              <span className="text-xs text-rose-500 dark:text-rose-400">{t('streamAborted')}</span>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full border border-rose-300/40 bg-rose-300/10 px-2.5 py-1 text-[11px] text-rose-800 hover:bg-rose-300/20 dark:text-rose-200"
                                onClick={() => {
                                  const prevUserMsg = findPreviousUserMessage(messages, message.id)
                                  if (prevUserMsg) {
                                    setInput(prevUserMsg.content)
                                    composerTextareaRef.current?.focus()
                                  }
                                }}
                              >
                                <RefreshCw className="h-3 w-3" />
                                {t('retrySend')}
                              </button>
                            </div>
                          )}
                        </div>
                        {group.tools.length > 0 ? (
                          <div className="space-y-2">
                            {group.tools.map((toolMessage) => (
                              toolMessage.toolStep ? (
                                <ToolCallCard key={toolMessage.id} step={toolMessage.toolStep} t={t} attached />
                              ) : toolMessage.status === 'streaming' ? (
                                <span key={toolMessage.id} className="inline-flex items-center gap-1.5" role="status">
                                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500 dark:bg-cyan-400" />
                                  <span className="text-xs text-muted-foreground animate-pulse">{t('streamingInProgress')}</span>
                                </span>
                              ) : null
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                }

                const message = group.message
                return (
                <div
                  key={message.id}
                  className={cn('flex gap-3', message.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  {/* Tool message — compact card, aligned with grouped tools */}
                  {message.role === 'tool' && (
                    <>
                      <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan-400/15 text-cyan-700 dark:text-cyan-200">
                        <Bot className="h-5 w-5" />
                      </div>
                      <div className="max-w-[88%] space-y-2">
                        <div className="space-y-2">
                          {message.toolStep && (
                            <ToolCallCard step={message.toolStep} t={t} attached />
                          )}
                          {message.status === 'streaming' && !message.toolStep && (
                            <span className="inline-flex items-center gap-1.5" role="status">
                              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500 dark:bg-cyan-400" />
                              <span className="text-xs text-muted-foreground animate-pulse">{t('streamingInProgress')}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {/* User and assistant messages */}
                  {message.role !== 'tool' && (
                    <>
                      {message.role === 'assistant' && (
                        <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan-400/15 text-cyan-700 dark:text-cyan-200">
                          <Bot className="h-5 w-5" />
                        </div>
                      )}

                      <div
                        className={cn(
                          'max-w-[82%] rounded-[26px] border px-5 py-4 shadow-lg',
                          message.role === 'user'
                            ? 'border-cyan-400/30 bg-cyan-400/15 text-foreground dark:text-white'
                            : 'border-border/70 bg-background/70 text-foreground dark:border-white/10 dark:bg-white/5'
                        )}
                      >
                        <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                          {message.role === 'user' ? <User className="h-3.5 w-3.5" /> : <BrainCircuit className="h-3.5 w-3.5" />}
                          <span>{message.role === 'user' ? t('you') : t('structureClawAi')}</span>
                          <span className="text-slate-500">{formatDate(message.timestamp, locale)}</span>
                        </div>
                        {message.presentation ? (
                          <MessagePresentationView
                            presentation={message.presentation}
                            t={t}
                            resolveSkillName={(skillId: string) => {
                              const skill = availableSkills.find((s) => s.id === skillId)
                              if (!skill) return skillId
                              return locale === 'zh' ? (skill.name.zh || skill.name.en || skillId) : (skill.name.en || skill.name.zh || skillId)
                            }}
                          />
                        ) : message.content ? (
                          message.role === 'assistant'
                            ? <MarkdownBody compact content={message.content} />
                            : <div className="whitespace-pre-wrap text-sm leading-7">{message.content}</div>
                        ) : null}
                        {message.role === 'user' && message.attachments && message.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {message.attachments.map((att) => (
                              <span
                                key={att.fileId}
                                className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[11px] text-foreground/80 dark:text-white/80"
                                title={att.relPath}
                              >
                                <FileText className="h-3 w-3 shrink-0" />
                                <span className="max-w-[180px] truncate">{att.originalName}</span>
                                {typeof att.size === 'number' && (
                                  <span className="text-muted-foreground">
                                    {att.size < 1024 ? `${att.size}B` : att.size < 1024 * 1024 ? `${Math.round(att.size / 1024)}KB` : `${(att.size / 1024 / 1024).toFixed(1)}MB`}
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                        {message.status === 'streaming' && (
                          <span className="inline-flex items-center gap-1.5 mt-1" role="status">
                            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500 dark:bg-cyan-400" />
                            <span className="text-xs text-muted-foreground animate-pulse">{t('streamingInProgress')}</span>
                          </span>
                        )}
                        {message.status === 'aborted' && (
                          <span className="ml-2 inline-flex items-center gap-1 text-xs text-rose-500 dark:text-rose-400">
                            <Square className="h-2.5 w-2.5" />
                            {t('streamAborted')}
                          </span>
                        )}
                        {message.status === 'error' && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-xs text-rose-500 dark:text-rose-400">{t('streamAborted')}</span>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-full border border-rose-300/40 bg-rose-300/10 px-2.5 py-1 text-[11px] text-rose-800 hover:bg-rose-300/20 dark:text-rose-200"
                          onClick={() => {
                            const prevUserMsg = findPreviousUserMessage(messages, message.id)
                            if (prevUserMsg) {
                              setInput(prevUserMsg.content)
                              composerTextareaRef.current?.focus()
                            }
                          }}
                        >
                          <RefreshCw className="h-3 w-3" />
                          {t('retrySend')}
                        </button>
                      </div>
                    )}
                    {message.role === 'assistant' && extractPdfUrl(message.content) && (
                      <div className="group/pdf mt-3 overflow-hidden rounded-xl border border-border/70 dark:border-white/10">
                        <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5 dark:border-white/10">
                          <span className="text-xs font-medium text-muted-foreground">PDF</span>
                          <button
                            type="button"
                            onClick={() => window.open(extractPdfUrl(message.content)!, '_blank')}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <Maximize2 className="h-3 w-3" />
                            {locale === 'zh' ? '全屏查看' : 'Fullscreen'}
                          </button>
                        </div>
                        <iframe
                          src={extractPdfUrl(message.content)!}
                          className="h-[480px] w-full border-0"
                          title="PDF Preview"
                        />
                      </div>
                    )}
                    {message.role === 'assistant' && message.debugDetails && !message.presentation && (
                      <details className="mt-3 rounded-2xl border border-border/70 bg-background/60 px-3 py-2 dark:border-white/10 dark:bg-slate-950/40">
                        <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                          {t('promptThinkingToggle')}
                        </summary>
                        <div className="mt-3 space-y-3">
                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingPrompt')}</div>
                            <pre className="max-h-52 overflow-auto rounded-xl border border-border/70 bg-background/70 p-2 text-[11px] leading-5 text-foreground dark:border-white/10 dark:bg-black/20">
                              {message.debugDetails.promptSnapshot}
                            </pre>
                          </div>

                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingSkills')}</div>
                            {message.debugDetails.skillIds.length > 0 ? (
                              <div className="flex flex-wrap gap-1.5">
                                {message.debugDetails.skillIds.map((skillId) => (
                                  <Badge key={`${message.id}-skill-${skillId}`} variant="outline" className="text-[10px]">
                                    {skillId}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground">{t('promptThinkingNoSkills')}</div>
                            )}
                          </div>

                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingResolvedSkills')}</div>
                            {message.debugDetails.routing ? (
                              <div className="space-y-2 rounded-xl border border-border/70 bg-background/70 px-2.5 py-2 text-xs leading-5 text-muted-foreground dark:border-white/10 dark:bg-black/20">
                                {message.debugDetails.routing.structuralSkillId ? (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-foreground">{t('promptThinkingStructuralSkill')}</span>
                                    <Badge variant="outline" className="text-[10px]">
                                      {message.debugDetails.routing.structuralSkillId}
                                    </Badge>
                                  </div>
                                ) : null}
                                {message.debugDetails.routing.analysisSkillId ? (
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-foreground">{t('promptThinkingAnalysisSkill')}</span>
                                    <Badge variant="outline" className="text-[10px]">
                                      {message.debugDetails.routing.analysisSkillId}
                                    </Badge>
                                  </div>
                                ) : null}
                                {message.debugDetails.routing.analysisSkillIds && message.debugDetails.routing.analysisSkillIds.length > 1 ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {message.debugDetails.routing.analysisSkillIds.map((skillId) => (
                                      <Badge key={`${message.id}-resolved-analysis-${skillId}`} variant="outline" className="text-[10px]">
                                        {skillId}
                                      </Badge>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground">{t('promptThinkingNoResolvedSkills')}</div>
                            )}
                          </div>

                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingResponse')}</div>
                            <div className="rounded-xl border border-border/70 bg-background/70 px-2.5 py-2 text-xs leading-5 text-muted-foreground dark:border-white/10 dark:bg-black/20">
                              {message.debugDetails.responseSummary || t('noNaturalLanguageSummary')}
                            </div>
                          </div>

                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingProcess')}</div>
                            {message.debugDetails.plan.length > 0 ? (
                              <ol className="space-y-1.5 text-xs text-muted-foreground">
                                {message.debugDetails.plan.map((step, index) => (
                                  <li key={`${message.id}-plan-${index}`} className="flex gap-2">
                                    <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cyan-300/15 text-[10px] text-cyan-700 dark:text-cyan-200">
                                      {index + 1}
                                    </span>
                                    <span>{step}</span>
                                  </li>
                                ))}
                              </ol>
                            ) : (
                              <div className="text-xs text-muted-foreground">{t('promptThinkingNoPlan')}</div>
                            )}
                          </div>

                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingToolCalls')}</div>
                            {message.debugDetails.toolCalls.length > 0 ? (
                              <div className="space-y-2">
                                {message.debugDetails.toolCalls.map((call, index) => (
                                  <div key={`${message.id}-tool-${call.tool}-${index}`} className="rounded-xl border border-border/70 bg-background/70 px-2.5 py-2 text-xs dark:border-white/10 dark:bg-black/20">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground">{call.tool}</span>
                                      <Badge variant="outline" className="text-[10px]">
                                        {call.status === 'success' ? t('toolCallStatusSuccess') : t('toolCallStatusError')}
                                      </Badge>
                                      {typeof call.durationMs === 'number' ? (
                                        <span className="text-muted-foreground">{call.durationMs} ms</span>
                                      ) : null}
                                    </div>
                                    {call.error ? (
                                      <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-300">{call.error}</div>
                                    ) : null}
                                    <details className="mt-2 rounded-lg border border-border/70 bg-background/60 px-2 py-1.5 dark:border-white/10 dark:bg-slate-950/40">
                                      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                                        {t('promptThinkingToolCallToggle')} #{index + 1}
                                      </summary>
                                      <div className="mt-2 space-y-2">
                                        <div>
                                          <div className="mb-1 text-[11px] font-medium text-foreground">{t('promptThinkingToolInput')}</div>
                                          <pre className="max-h-44 overflow-auto rounded-md border border-border/70 bg-background/70 p-2 text-[10px] leading-5 text-foreground dark:border-white/10 dark:bg-black/20">
                                            {formatDebugPayload(call.input, t('promptThinkingNoInput'))}
                                          </pre>
                                        </div>
                                        <div>
                                          <div className="mb-1 text-[11px] font-medium text-foreground">{t('promptThinkingToolOutput')}</div>
                                          <pre className="max-h-44 overflow-auto rounded-md border border-border/70 bg-background/70 p-2 text-[10px] leading-5 text-foreground dark:border-white/10 dark:bg-black/20">
                                            {formatDebugPayload(call.output, t('promptThinkingNoOutput'))}
                                          </pre>
                                        </div>
                                      </div>
                                    </details>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-xs text-muted-foreground">{t('promptThinkingNoToolCalls')}</div>
                            )}
                          </div>
                        </div>
                      </details>
                    )}
                  </div>

                  {message.role === 'user' && (
                    <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-muted/70 text-muted-foreground dark:bg-white/10 dark:text-slate-200">
                      <User className="h-5 w-5" />
                    </div>
                  )}
                  </>
                  )}
                </div>
                )
              })}
              {!isStreaming && sessionRuntime.view?.waitingForReply && (
                <div data-testid="pending-clarification" role="status" className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 px-5 py-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-cyan-800 dark:text-cyan-200">{t('clarificationTitle')}</p>
                    <Button type="button" variant="outline" size="sm" className="rounded-full"
                      disabled={Boolean(endingTurnConversationId || sessionRuntime.view.busy || !sessionRuntime.view.usage?.runId)}
                      title={!sessionRuntime.view.usage?.runId ? t('endTurnConflict') : undefined} onClick={() => void handleEndTurn()}>
                      {endingTurnConversationId === conversationId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t('endTurn')}
                    </Button>
                  </div>
                  {sessionRuntime.view.question && <MarkdownBody compact content={sessionRuntime.view.question} />}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {pendingOptions.length > 0 && !isStreaming && (
            <div className="flex flex-wrap gap-2 px-4 py-2">
              {pendingOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={Boolean(endingTurnConversationId)}
                  onClick={() => {
                    handleSubmit(option)
                  }}
                  className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1.5 text-sm text-cyan-700 transition hover:bg-cyan-300/20 hover:border-cyan-300/50 dark:text-cyan-300"
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          <div data-testid="console-composer" className="border-t border-border/70 px-3 py-3 2xl:px-4 dark:border-white/10 overflow-y-auto max-h-[40vh]">
            <div className="w-full space-y-3">
              {errorMessage && (
                <div role="alert" className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                  {errorMessage}
                </div>
              )}
              {composerInput}
            </div>
          </div>
        </div>
        )}
      </section>
      </div>

      <StructuralVisualizationModal
        locale={locale}
        onClose={() => setVisualizationOpen(false)}
        open={visualizationOpen}
        snapshot={activeVisualizationSnapshot}
        t={t}
      />
      <DialogShell
        open={resultDialogOpen}
        title={activePanel === 'context' && !latestResult ? t('contextPanelLabel') : t('resultPanelDialogTitle')}
        closeLabel={t('closeResultPanel')}
        onClose={() => setResultDialogOpen(false)}
        className="max-w-7xl"
        contentClassName="p-0"
      >
        <div className="h-full p-2 sm:p-4">
          <AnalysisPanel
            activeTab={activePanel}
            locale={locale}
            modelVisualizationSnapshot={latestModelVisualizationSnapshot}
            onOpenVisualization={openVisualization}
            onTabChange={setActivePanel}
            panelIdPrefix="dialog-output"
            result={latestResult}
            t={t}
            visualizationSnapshot={latestResultVisualizationSnapshot}
            modelText={modelText}
            onModelTextChange={(val) => { modelEditSequenceRef.current++; modelEditedRef.current = true; setModelText(val); setModelSyncMessage('') }}
            modelSyncMessage={modelSyncMessage}
            parsedComposerModelError={parsedComposerModelError}
          />
        </div>
      </DialogShell>
      <ResultReviewPanel open={resultReviewOpen} onClose={() => setResultReviewOpen(false)} conversationId={conversationId}
        locale={locale} disabled={isStreaming || Boolean(sessionRuntime.view?.busy)} onUsageChanged={() => { void sessionRuntime.refresh().catch(() => {}) }} />
      <InputReviewPanel open={inputReviewOpen} onClose={() => setInputReviewOpen(false)} conversationId={conversationId}
        locale={locale} disabled={isStreaming} attachments={[...messages.flatMap(message => message.attachments ?? []), ...attachedFiles]}
        initialContext={{ locale, runPolicy, skillIds: selectedSkillIds, enabledToolIds: selectedToolIds,
          attachments: [...messages.flatMap(message => message.attachments ?? []), ...attachedFiles], restrictFileAccessToAttachments: true }}
        onUpdate={review => {
          if (review.conversationId !== conversationIdRef.current) return
          void sessionRuntime.refresh().catch(() => {})
          if (review.model) applySynchronizedModel(review.model, 'tool')
          if (!review.analysisCurrent) {
            const cleared = latestResult ? { ...latestResult, analysis: undefined, codeCheck: undefined, report: undefined } : null
            setLatestResult(cleared); lastValidResultRef.current = cleared
            setLatestResultVisualizationSnapshot(null); lastValidResultVisualizationRef.current = null
            setConversationArchive(current => current[conversationId] ? { ...current, [conversationId]: {
              ...current[conversationId], latestResult: cleared, resultVisualizationSnapshot: null, visualizationSnapshot: null, staleStructuralData: true,
            } } : current)
          }
          setModelSyncMessage(locale === 'zh' ? '已保存当前会话的输入复核，请按提示校验与重算。' : 'Input review saved to this conversation. Validate and recalculate as indicated.')
        }} />
      {probePopupOpen && Object.keys(probeResults).length > 0 && probeButtonRef.current && typeof window !== 'undefined' && createPortal(
        <>
          <div
            className="fixed inset-0 z-70"
            onClick={() => setProbePopupOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setProbePopupOpen(false) }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('probeResultsDialogTitle')}
            className="fixed z-71 w-80 rounded-xl border border-border/70 bg-card p-4 shadow-xl dark:border-white/10 dark:bg-slate-950"
            style={{
              bottom: window.innerHeight - probeButtonRef.current.getBoundingClientRect().top + 8,
              left: Math.max(0, Math.min(probeButtonRef.current.getBoundingClientRect().left, window.innerWidth - 336)),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setProbePopupOpen(false) }}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">{t('engineProbeButton')}</span>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setProbePopupOpen(false)}
                aria-label={t('closeLabel')}
              >
                ✕
              </button>
            </div>
            <div className="space-y-2.5">
              {allEngines.map((engine) => {
                const probe = probeResults[engine.id]
                if (!probe) return null
                return (
                  <div key={engine.id} className="rounded-lg border border-border/50 bg-background/60 p-2.5 dark:border-white/5 dark:bg-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {probe.loading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                        ) : (
                          <span className={`inline-block h-2 w-2 rounded-full ${probe.passed ? 'bg-emerald-500' : 'bg-red-400'}`} />
                        )}
                        <span className="text-xs font-medium text-foreground">{engine.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {probe.loading ? t('engineProbeRunning')
                            : probe.passed ? t('engineProbePassed')
                            : t('engineProbeFailed')}
                        </span>
                        {!probe.loading && !probe.passed && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50 dark:text-cyan-300 dark:hover:bg-cyan-900/30"
                            onClick={() => probeSingleEngine(engine.id)}
                            aria-label={`${t('retryLabel')} ${engine.name}`}
                          >
                            <RefreshCw className="h-2.5 w-2.5" />
                            {t('retryLabel')}
                          </button>
                        )}
                      </div>
                    </div>
                    {probe.durationMs != null && !probe.loading && (
                      <div className="mt-1 text-[11px] text-muted-foreground">{t('engineProbeDuration')}: {probe.durationMs}ms</div>
                    )}
                    {probe.error && !probe.loading && (
                      <div className="mt-1 text-[11px] leading-4 text-red-600 dark:text-red-400" role="alert">{probe.error}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
