import { Badge } from '@/components/ui/badge'
import type { MessageKey } from '@/lib/i18n'
import type { Message, MessageDebugDetails as MessageDebugDetailsData } from './types'
import { formatDebugPayload } from './message-utils'

/** Collapsible prompt / routing / tool-call debug details of an assistant message. */
export function MessageDebugDetails({
  message,
  debugDetails,
  t,
}: {
  message: Message
  debugDetails: MessageDebugDetailsData
  t: (key: MessageKey) => string
}) {
  return (
    <details className="mt-3 rounded-2xl border border-border/70 bg-background/60 px-3 py-2 dark:border-white/10 dark:bg-slate-950/40">
      <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {t('promptThinkingToggle')}
      </summary>
      <div className="mt-3 space-y-3">
        <div>
          <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingPrompt')}</div>
          <pre className="max-h-52 overflow-auto rounded-xl border border-border/70 bg-background/70 p-2 text-[11px] leading-5 text-foreground dark:border-white/10 dark:bg-black/20">
            {debugDetails.promptSnapshot}
          </pre>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingSkills')}</div>
          {debugDetails.skillIds.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {debugDetails.skillIds.map((skillId) => (
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
          {debugDetails.routing ? (
            <div className="space-y-2 rounded-xl border border-border/70 bg-background/70 px-2.5 py-2 text-xs leading-5 text-muted-foreground dark:border-white/10 dark:bg-black/20">
              {debugDetails.routing.structuralSkillId ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{t('promptThinkingStructuralSkill')}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {debugDetails.routing.structuralSkillId}
                  </Badge>
                </div>
              ) : null}
              {debugDetails.routing.analysisSkillId ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{t('promptThinkingAnalysisSkill')}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {debugDetails.routing.analysisSkillId}
                  </Badge>
                </div>
              ) : null}
              {debugDetails.routing.analysisSkillIds && debugDetails.routing.analysisSkillIds.length > 1 ? (
                <div className="flex flex-wrap gap-1.5">
                  {debugDetails.routing.analysisSkillIds.map((skillId) => (
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
            {debugDetails.responseSummary || t('noNaturalLanguageSummary')}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-foreground">{t('promptThinkingProcess')}</div>
          {debugDetails.plan.length > 0 ? (
            <ol className="space-y-1.5 text-xs text-muted-foreground">
              {debugDetails.plan.map((step, index) => (
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
          {debugDetails.toolCalls.length > 0 ? (
            <div className="space-y-2">
              {debugDetails.toolCalls.map((call, index) => (
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
  )
}
