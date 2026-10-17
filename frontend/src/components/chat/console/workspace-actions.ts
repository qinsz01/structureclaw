import type { VisualizationSnapshot } from '@/components/visualization/types'
import { API_BASE } from '@/lib/api-base'
import { isResultVisualizationSnapshot, buildResultSnapshotFromResult } from './snapshot-utils'
import type { ConsoleState } from './use-console-state'
import type { ConversationMutators } from './conversation-mutators'

/** Visualization opening, model synchronization and file uploads. */
export function createWorkspaceActions(state: ConsoleState, mutators: ConversationMutators) {
  const {
    conversationId,
    hasBoundAnalysisRun,
    setResultDialogOpen,
    setResultReviewOpen,
    mergedConversations,
    modelPreviewBaseTitle,
    t,
    latestResult,
    latestResultVisualizationSnapshot,
    parsedComposerModel,
    setLatestResultVisualizationSnapshot,
    setVisualizationSource,
    setVisualizationOpen,
    latestModelVisualizationSnapshot,
    modelEditedRef,
    displayedModelRevisionRef,
    modelText,
    setModelText,
    setModelSyncMessage,
    setActivePanel,
    setErrorMessage,
    setUploadingCount,
    setAttachedFiles,
  } = state
  const { persistConversationSnapshotsToArchive, ensureConversation } = mutators

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

  return { openVisualization, applySynchronizedModel, handleFileSelect }
}

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>
