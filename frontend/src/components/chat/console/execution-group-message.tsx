import type { RefObject } from 'react'
import { Bot, BrainCircuit, RefreshCw, Square } from 'lucide-react'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { formatDate } from '@/lib/utils'
import { MarkdownBody } from '../markdown-body'
import { MessagePresentationView } from '../message-presentation'
import { ToolCallCard } from '../tool-call-card'
import type { AgentSkillSummary, Message, MessageRenderGroup } from './types'
import { findPreviousUserMessage } from './message-utils'

/** An execution-mode assistant message with its attached tool call cards. */
export function ExecutionGroupMessage({
  group,
  t,
  locale,
  availableSkills,
  messages,
  setInput,
  composerTextareaRef,
}: {
  group: Extract<MessageRenderGroup, { type: 'assistant-execution' }>
  t: (key: MessageKey) => string
  locale: AppLocale
  availableSkills: AgentSkillSummary[]
  messages: Message[]
  setInput: (value: string) => void
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>
}) {
  const message = group.assistant
  return (
    <div data-testid="assistant-execution-group" className="flex justify-start gap-3">
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
