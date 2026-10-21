import { useEffect, useMemo, useRef, useState } from 'react'
import type { VisualizationSnapshot } from '@/components/visualization/types'
import { useI18n } from '@/lib/i18n'
import { useStore } from '@/lib/stores/context'
import type { RunPolicyInput } from '../run-settings'
import { useConversationRuntime } from '../use-conversation-runtime'
import { normalizeClarificationOptions } from '../clarification-options'
import type { AssistantPresentation } from '../message-presentation'
import type { AgentResult, Message, PanelTab, UploadedFileAttachment } from './types'
import { groupMessagesForRendering } from './message-utils'
import { buildActiveConversationArchiveEntry } from './archive-entry'
import { useConversationHistory } from './use-conversation-history'
import { useStreamSessions } from './use-stream-sessions'
import { useCapabilityCatalog } from './use-capability-catalog'
import { useAnalysisEngines } from './use-analysis-engines'
import { useModelDraft } from './use-model-draft'
import { useConsoleLayout } from './use-console-layout'
import { useChatAutoScroll } from './use-chat-autoscroll'

/**
 * All AI console state: local React state, the feature hooks and the effects
 * that tie them together. Handlers and views receive the returned object.
 */
export function useConsoleState() {
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
  const [attachedFiles, setAttachedFiles] = useState<UploadedFileAttachment[]>([])
  const [uploadingCount, setUploadingCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [conversationId, setConversationId] = useState('')
  const [runPolicy, setRunPolicy] = useState<RunPolicyInput>({})
  useEffect(() => { setRunPolicy({}) }, [conversationId])
  const history = useConversationHistory(t)
  const { serverConversations, setConversationArchive, conversationActivityAt, mergedConversations, deletedConversationIdsRef } = history
  const streams = useStreamSessions(conversationId)
  const currentPresentationRef = useRef<AssistantPresentation | null>(null)
  const conversationIdRef = useRef(conversationId)
  const submittingRef = useRef(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [endingTurnConversationId, setEndingTurnConversationId] = useState('')
  const sessionRuntime = useConversationRuntime(conversationId, isStreaming)
  const conversationSelectionRef = useRef(0)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  const [errorMessage, setErrorMessage] = useState('')
  const catalog = useCapabilityCatalog(locale, sessionRuntime.view, runPolicy)
  const { selectedSkillIds, selectedToolIds, hasExplicitSkillSelection, hasExplicitToolSelection } = catalog
  const engines = useAnalysisEngines()
  const model = useModelDraft({ t, conversationId, messages, mergedConversations, sessionView: sessionRuntime.view })
  const { modelText, modelSyncMessage, latestModelVisualizationSnapshot, parsedComposerModelError } = model
  const [latestResult, setLatestResult] = useState<AgentResult | null>(null)
  const [latestResultVisualizationSnapshot, setLatestResultVisualizationSnapshot] = useState<VisualizationSnapshot | null>(null)
  const [visualizationOpen, setVisualizationOpen] = useState(false)
  const [visualizationSource, setVisualizationSource] = useState<'model' | 'result'>('result')
  const [activePanel, setActivePanel] = useState<PanelTab>('analysis')
  const [pendingDeleteConversationId, setPendingDeleteConversationId] = useState('')
  const [deletingConversationId, setDeletingConversationId] = useState('')
  const [resultDialogOpen, setResultDialogOpen] = useState(false)
  const [inputReviewOpen, setInputReviewOpen] = useState(false)
  const [resultReviewOpen, setResultReviewOpen] = useState(false)
  const layout = useConsoleLayout()
  const { uiPreferences, isSidebarLayout } = layout
  const chatScrollRef = useChatAutoScroll(messages, isStreaming)
  // Interaction option chips from ask_user_clarification
  const [pendingOptions, setPendingOptions] = useState<string[]>([])
  useEffect(() => { setPendingOptions(sessionRuntime.view?.waitingForReply ? normalizeClarificationOptions(sessionRuntime.view.options) : []) }, [sessionRuntime.view, conversationId])

  const messageRenderGroups = useMemo(() => groupMessagesForRendering(messages), [messages])

  useEffect(() => {
    setMessages((current) => {
      if (current.length !== 1 || current[0]?.id !== 'welcome') {
        return current
      }
      return [initialAssistantMessage]
    })
  }, [initialAssistantMessage])

  const composerTextareaRef = useRef<HTMLTextAreaElement>(null)

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

  useEffect(() => {
    if (!conversationId || deletedConversationIdsRef.current.has(conversationId)) {
      return
    }

    setConversationArchive((current) => ({
      ...current,
      [conversationId]: buildActiveConversationArchiveEntry(current, {
        conversationId,
        serverConversations,
        messages,
        t,
        conversationActivityAt,
        modelText,
        selectedSkillIds,
        selectedToolIds,
        hasExplicitSkillSelection,
        hasExplicitToolSelection,
        modelSyncMessage,
        activePanel,
        latestResult,
        latestModelVisualizationSnapshot,
        latestResultVisualizationSnapshot,
      }),
    }))
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
    // Stable ref/setter from useConversationHistory (identity never changes).
    deletedConversationIdsRef,
    setConversationArchive,
  ])

  const historyCollapsed = uiPreferences.historyCollapsed && isSidebarLayout
  const isIdle = messages.length <= 1

  return {
    t,
    locale,
    openWorkspaceSettings,
    initialAssistantMessage,
    quickPrompts,
    messages,
    setMessages,
    messagesRef,
    input,
    setInput,
    attachedFiles,
    setAttachedFiles,
    uploadingCount,
    setUploadingCount,
    fileInputRef,
    conversationId,
    setConversationId,
    runPolicy,
    setRunPolicy,
    ...history,
    ...streams,
    currentPresentationRef,
    conversationIdRef,
    submittingRef,
    isStreaming,
    setIsStreaming,
    endingTurnConversationId,
    setEndingTurnConversationId,
    sessionRuntime,
    conversationSelectionRef,
    errorMessage,
    setErrorMessage,
    ...catalog,
    ...engines,
    ...model,
    latestResult,
    setLatestResult,
    latestResultVisualizationSnapshot,
    setLatestResultVisualizationSnapshot,
    visualizationOpen,
    setVisualizationOpen,
    visualizationSource,
    setVisualizationSource,
    activePanel,
    setActivePanel,
    pendingDeleteConversationId,
    setPendingDeleteConversationId,
    deletingConversationId,
    setDeletingConversationId,
    resultDialogOpen,
    setResultDialogOpen,
    inputReviewOpen,
    setInputReviewOpen,
    resultReviewOpen,
    setResultReviewOpen,
    ...layout,
    chatScrollRef,
    pendingOptions,
    setPendingOptions,
    messageRenderGroups,
    composerTextareaRef,
    hasBoundAnalysisRun,
    activeVisualizationSnapshot,
    historyCollapsed,
    isIdle,
  }
}

export type ConsoleState = ReturnType<typeof useConsoleState>
