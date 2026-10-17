import type { RefObject } from 'react'
import { Bot, BrainCircuit, FileText, Maximize2, RefreshCw, Square, User } from 'lucide-react'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { cn, formatDate } from '@/lib/utils'
import { MarkdownBody } from '../markdown-body'
import { MessagePresentationView } from '../message-presentation'
import { ToolCallCard } from '../tool-call-card'
import type { AgentSkillSummary, Message } from './types'
import { extractPdfUrl, findPreviousUserMessage } from './message-utils'
import { MessageDebugDetails } from './message-debug-details'

/** A single user, assistant or (ungrouped) tool message. */
export function ChatMessageBubble({
  message,
  t,
  locale,
  availableSkills,
  messages,
  setInput,
  composerTextareaRef,
}: {
  message: Message
  t: (key: MessageKey) => string
  locale: AppLocale
  availableSkills: AgentSkillSummary[]
  messages: Message[]
  setInput: (value: string) => void
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>
}) {
  return (
    <div
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
          <MessageDebugDetails message={message} debugDetails={message.debugDetails} t={t} />
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
}
