import dynamic from 'next/dynamic'
import { DialogShell } from '@/components/ui/dialog-shell'
import { ResultReviewPanel } from '../result-review-panel'
import { InputReviewPanel } from '../input-review-panel'
import { AnalysisPanel } from './analysis-panel'
import type { ConsoleState } from './use-console-state'
import type { WorkspaceActions } from './workspace-actions'

const StructuralVisualizationModal = dynamic(
  () => import('@/components/visualization/modal').then((mod) => mod.StructuralVisualizationModal),
  { ssr: false }
)

/** Visualization modal, results dialog and the input/result review panels. */
export function ConsoleDialogs({
  state,
  openVisualization,
  applySynchronizedModel,
}: {
  state: ConsoleState
  openVisualization: WorkspaceActions['openVisualization']
  applySynchronizedModel: WorkspaceActions['applySynchronizedModel']
}) {
  const {
    locale,
    setVisualizationOpen,
    visualizationOpen,
    activeVisualizationSnapshot,
    t,
    resultDialogOpen,
    activePanel,
    latestResult,
    setResultDialogOpen,
    latestModelVisualizationSnapshot,
    setActivePanel,
    latestResultVisualizationSnapshot,
    modelText,
    modelEditSequenceRef,
    modelEditedRef,
    setModelText,
    setModelSyncMessage,
    modelSyncMessage,
    parsedComposerModelError,
    resultReviewOpen,
    setResultReviewOpen,
    conversationId,
    isStreaming,
    sessionRuntime,
    inputReviewOpen,
    setInputReviewOpen,
    messages,
    attachedFiles,
    runPolicy,
    selectedSkillIds,
    selectedToolIds,
    conversationIdRef,
    setLatestResult,
    setLatestResultVisualizationSnapshot,
    setConversationArchive,
  } = state

  return (
    <>
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
            setLatestResult(cleared)
            setLatestResultVisualizationSnapshot(null)
            setConversationArchive(current => current[conversationId] ? { ...current, [conversationId]: {
              ...current[conversationId], latestResult: cleared, resultVisualizationSnapshot: null, visualizationSnapshot: null, staleStructuralData: true,
            } } : current)
          }
          setModelSyncMessage(locale === 'zh' ? '已保存当前会话的输入复核，请按提示校验与重算。' : 'Input review saved to this conversation. Validate and recalculate as indicated.')
        }} />
    </>
  )
}
