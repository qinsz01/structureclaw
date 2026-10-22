import type { ReactNode } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownBody } from '../markdown-body'
import { ExecutionGroupMessage } from './execution-group-message'
import { ChatMessageBubble } from './chat-message-bubble'
import type { ConsoleState } from './use-console-state'

/** Active state: scrolling transcript, pending clarification, option chips and composer. */
export function ChatTranscript({
  state,
  composer,
  handleSubmit,
  handleEndTurn,
}: {
  state: ConsoleState
  composer: ReactNode
  handleSubmit: (overrideInput?: string) => Promise<void>
  handleEndTurn: () => Promise<void>
}) {
  const {
    chatScrollRef,
    messages,
    quickPrompts,
    setInput,
    messageRenderGroups,
    t,
    locale,
    availableSkills,
    composerTextareaRef,
    isStreaming,
    sessionRuntime,
    endingTurnConversationId,
    conversationId,
    pendingOptions,
    errorMessage,
  } = state
  const messageProps = { t, locale, availableSkills, messages, setInput, composerTextareaRef }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={chatScrollRef}
        data-testid="console-chat-scroll"
        className="min-h-0 flex-1 overflow-auto px-4 py-4 2xl:px-5 2xl:py-5"
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

          {messageRenderGroups.map((group) => {
            if (group.type === 'assistant-execution') {
              return <ExecutionGroupMessage key={group.assistant.id} group={group} {...messageProps} />
            }
            return <ChatMessageBubble key={group.message.id} message={group.message} {...messageProps} />
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
          <div />
        </div>
      </div>

      {pendingOptions.length > 0 && !isStreaming && (
        <div className="flex max-h-[20dvh] shrink-0 flex-wrap gap-2 overflow-y-auto px-4 py-2">
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

      <div data-testid="console-composer" className="shrink-0 border-t border-border/70 px-3 py-3 2xl:px-4 dark:border-white/10 overflow-y-auto max-h-[60dvh] xl:max-h-[40dvh]">
        <div className="w-full space-y-3">
          {errorMessage && (
            <div role="alert" className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
              {errorMessage}
            </div>
          )}
          {composer}
        </div>
      </div>
    </div>
  )
}
