import { Clock3, Loader2, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Settings, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/ui/dialog-shell'
import { cn, formatDate } from '@/lib/utils'
import type { ConsoleState } from './use-console-state'

type HistorySidebarProps = {
  state: ConsoleState
  handleNewConversation: () => void
  handleSelectConversation: (nextConversationId: string) => Promise<void>
  handleDeleteConversation: (targetConversationId: string) => Promise<void>
}

/** Shared history list for the desktop sidebar and narrow-screen dialog. */
function HistoryPanel({
  state,
  handleNewConversation,
  handleSelectConversation,
  handleDeleteConversation,
  historyCollapsed,
  onCollapse,
  onExpand,
  openWorkspaceSettings,
  testId,
}: HistorySidebarProps & {
  historyCollapsed: boolean
  onCollapse: () => void
  onExpand: () => void
  openWorkspaceSettings: ConsoleState['openWorkspaceSettings']
  testId: string
}) {
  const {
    t,
    loadedModules,
    loadedTools,
    historyLoading,
    historyError,
    mergedConversations,
    conversationId,
    pendingDeleteConversationId,
    deletingConversationId,
    conversationArchive,
    setPendingDeleteConversationId,
    locale,
    streamingSessions,
  } = state

  return (
    <aside
      data-testid={testId}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden bg-card/95 dark:bg-slate-950/90',
        historyCollapsed && 'items-center px-2 py-4'
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
            onClick={onExpand}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <button
            type="button"
            className="mt-2 h-9 w-9 rounded-lg overflow-hidden"
            aria-label={t('expandHistoryPanel')}
            onClick={onExpand}
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
          <div className="mt-4 flex min-h-0 flex-1 items-center justify-center overflow-hidden">
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
              onClick={() => openWorkspaceSettings('llm')}
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="shrink-0 px-5 py-4">
            <div className="hidden items-center justify-between gap-3 xl:flex">
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
                onClick={onCollapse}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
            <Button
              type="button"
              className="w-full rounded-full bg-cyan-300 text-slate-950 hover:bg-cyan-200 xl:mt-4"
              onClick={handleNewConversation}
            >
              <MessageSquarePlus className="h-4 w-4" />
              {t('newConversation')}
            </Button>
          </div>

          <div data-testid="console-history-scroll" className="min-h-0 flex-1 overflow-auto overscroll-contain p-3">
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
          <div className="mt-auto shrink-0 border-t border-border/70 px-5 py-4 dark:border-white/10">
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
                onClick={() => openWorkspaceSettings('llm')}
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  )
}

/** Desktop history preference and temporary mobile navigation are independent. */
export function HistorySidebar(props: HistorySidebarProps) {
  const { state, handleNewConversation, handleSelectConversation } = props
  const { t, isSidebarLayout, historyCollapsed, setUiPreferences, mobileHistoryOpen, setMobileHistoryOpen } = state
  const closeHistory = () => setMobileHistoryOpen(false)
  const openWorkspaceSettings: ConsoleState['openWorkspaceSettings'] = tab => {
    closeHistory()
    state.openWorkspaceSettings(tab)
  }
  const newConversation = () => {
    handleNewConversation()
    closeHistory()
  }
  const selectConversation = async (id: string) => {
    await handleSelectConversation(id)
    closeHistory()
  }
  const panel = (
    <HistoryPanel {...props}
      handleNewConversation={newConversation}
      handleSelectConversation={selectConversation}
      historyCollapsed={isSidebarLayout && historyCollapsed}
      onCollapse={isSidebarLayout
        ? () => setUiPreferences(current => ({ ...current, historyCollapsed: true })) : closeHistory}
      onExpand={() => setUiPreferences(current => ({ ...current, historyCollapsed: false }))}
      openWorkspaceSettings={openWorkspaceSettings}
      testId={isSidebarLayout ? 'console-history-panel' : 'console-history-dialog-panel'} />
  )
  if (isSidebarLayout) return panel

  return <>
    <aside data-testid="console-history-panel" className="flex items-center justify-between gap-2 border-b border-border/70 bg-card/95 px-3 py-2 dark:border-white/10 dark:bg-slate-950/90">
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" size="icon" variant="ghost" className="shrink-0 rounded-full"
          aria-label={t('expandHistoryPanel')} aria-haspopup="dialog" aria-expanded={mobileHistoryOpen}
          onClick={() => setMobileHistoryOpen(true)}>
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <img src="/logo.png" alt="StructureClaw" className="h-7 w-7 shrink-0 rounded-lg" />
        <span className="hidden truncate text-xs uppercase tracking-[0.2em] text-cyan-700/80 sm:inline dark:text-cyan-200/70">StructureClaw</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" className="rounded-full bg-cyan-300 text-slate-950 hover:bg-cyan-200"
          aria-label={t('newConversation')} onClick={newConversation}>
          <MessageSquarePlus className="h-4 w-4" />
          <span className="hidden min-[360px]:inline">{t('newConversation')}</span>
        </Button>
        <Button type="button" size="icon" variant="ghost" className="rounded-full"
          aria-label={t('sidebarGearAriaLabel')} onClick={() => openWorkspaceSettings('llm')}>
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </aside>
    <DialogShell open={mobileHistoryOpen} title={t('historyPanelTitle')} closeLabel={t('collapseHistoryPanel')}
      onClose={closeHistory} className="ml-0 mr-auto max-w-sm" contentClassName="overflow-hidden p-0 sm:p-0">
      {panel}
    </DialogShell>
  </>
}
