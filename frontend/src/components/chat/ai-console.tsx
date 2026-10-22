'use client'

import { RunSettings } from './run-settings'

import { cn } from '@/lib/utils'
import { useConsoleState } from './console/use-console-state'
import { createConversationMutators } from './console/conversation-mutators'
import { createWorkspaceActions } from './console/workspace-actions'
import { createConversationSelection } from './console/conversation-selection'
import { createTurnSubmission } from './console/turn-submission'
import { ConsoleComposer } from './console/console-composer'
import { HistorySidebar } from './console/history-sidebar'
import { IdleWelcome } from './console/idle-welcome'
import { ChatTranscript } from './console/chat-transcript'
import { ConsoleDialogs } from './console/console-dialogs'
import { ProbeResultsPopup } from './console/probe-results-popup'

export { extractSummaryStats } from './console/summary-stats'

export function AIConsole() {
  const state = useConsoleState()
  const mutators = createConversationMutators(state)
  const workspace = createWorkspaceActions(state, mutators)
  const { handleSelectConversation, handleNewConversation, handleEndTurn, handleDeleteConversation } = createConversationSelection(state)
  const { handleSubmit } = createTurnSubmission(state, mutators, workspace)
  const { historyCollapsed, isIdle } = state

  const composerInput = (
    <ConsoleComposer state={state} handleSubmit={handleSubmit} handleFileSelect={workspace.handleFileSelect} />
  )

  const gridCols = historyCollapsed
    ? 'xl:grid-cols-[72px_minmax(0,1fr)] 2xl:grid-cols-[80px_minmax(0,1fr)]'
    : 'xl:grid-cols-[260px_minmax(0,1fr)] 2xl:grid-cols-[280px_minmax(0,1fr)]'

  return (
    <div
      data-testid="console-layout-grid"
      data-history-collapsed={String(historyCollapsed)}
      className={cn(
        'grid grid-cols-1 h-full min-h-screen xl:min-h-0 xl:overflow-hidden transition-[grid-template-columns] duration-300 ease-in-out',
        gridCols
      )}
    >
      <HistorySidebar
        state={state}
        handleNewConversation={handleNewConversation}
        handleSelectConversation={handleSelectConversation}
        handleDeleteConversation={handleDeleteConversation}
      />

      <div className="flex min-w-0 min-h-0 flex-col xl:min-h-0">
        <div className="flex items-center justify-end gap-1.5 px-3 py-2">
          <RunSettings value={state.runPolicy} onChange={state.setRunPolicy} defaults={state.globalRunPolicy} locale={state.locale}
            modelingSkills={state.availableSkills.filter(skill => state.skillDomainById[skill.id] === 'structure-type')
              .map(skill => ({ id: skill.id, label: skill.name[state.locale] || skill.id }))}
            disabled={state.isStreaming || Boolean(state.sessionRuntime.view?.busy || state.sessionRuntime.view?.waitingForReply)}
            runtime={state.sessionRuntime.view} statusError={state.sessionRuntime.error}
            onRefresh={state.conversationId ? () => { void state.sessionRuntime.refresh().catch(() => {}) } : undefined} />
        </div>

        <section
        data-testid="console-chat-panel"
        className="relative flex h-full flex-col overflow-hidden border-x border-border/50 bg-card/95 xl:min-h-0 dark:border-white/5 dark:bg-slate-950/90"
      >
        {isIdle ? (
          /* ── Idle state: centered welcome + composer ── */
          <IdleWelcome state={state} composer={composerInput} />
        ) : (
        /* ── Active state: chat messages + composer ── */
          <ChatTranscript state={state} composer={composerInput} handleSubmit={handleSubmit} handleEndTurn={handleEndTurn} />
        )}
      </section>
      </div>

      <ConsoleDialogs
        state={state}
        openVisualization={workspace.openVisualization}
        applySynchronizedModel={workspace.applySynchronizedModel}
      />
      <ProbeResultsPopup state={state} />
    </div>
  )
}
