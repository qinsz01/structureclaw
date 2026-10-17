import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { MessageKey } from '@/lib/i18n'
import { conversationStageLabel } from '@/lib/conversation-stage'
import { Badge } from '@/components/ui/badge'
import { MarkdownBody } from '../markdown-body'
import type { AgentInteraction, AgentResult } from './types'

export function GuidanceCard({
  guidance,
  result,
  t,
}: {
  guidance: AgentInteraction
  result: AgentResult
  t: (key: MessageKey) => string
}) {
  return (
    <Card
      data-testid="console-guidance-panel"
      className="border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50"
    >
      <CardHeader>
        <CardTitle className="text-lg">{t('guidancePanelTitle')}</CardTitle>
        <MarkdownBody compact content={result.response || t('guidancePanelBody')} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          {guidance.conversationStage && (
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4 dark:border-white/10 dark:bg-white/5">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('guidanceCurrentStage')}</div>
              <div className="mt-2 text-base font-semibold text-foreground">{conversationStageLabel(guidance.conversationStage, t)}</div>
            </div>
          )}
        </div>

        {guidance.fallbackSupportNote && (
          <div className="rounded-2xl border border-cyan-300/30 bg-cyan-300/10 p-4 text-sm leading-6 text-foreground">
            <div className="mb-2 text-xs uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-200">{t('guidanceSupportNote')}</div>
            <MarkdownBody compact content={guidance.fallbackSupportNote} className="prose-p:text-foreground dark:prose-p:text-foreground" />
          </div>
        )}

        {guidance.missingCritical?.length ? (
          <div>
            <div className="mb-3 text-sm font-medium text-foreground">{t('guidanceMissingCritical')}</div>
            <div className="flex flex-wrap gap-2">
              {guidance.missingCritical.map((field) => (
                <Badge key={field} className="border-amber-300/40 bg-amber-100/80 text-amber-950 dark:border-amber-200/20 dark:bg-amber-300/10 dark:text-amber-50" variant="outline">
                  {field}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {guidance.missingOptional?.length ? (
          <div>
            <div className="mb-3 text-sm font-medium text-foreground">{t('guidanceMissingOptional')}</div>
            <div className="flex flex-wrap gap-2">
              {guidance.missingOptional.map((field) => (
                <Badge key={field} className="border-border/70 bg-background/70 text-muted-foreground dark:border-white/10 dark:bg-white/5" variant="outline">
                  {field}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {guidance.recommendedNextStep && (
          <div className="rounded-2xl border border-border/70 bg-background/70 p-4 dark:border-white/10 dark:bg-white/5">
            <div className="mb-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('guidanceRecommendedNextStep')}</div>
            <MarkdownBody compact content={guidance.recommendedNextStep} className="prose-p:text-foreground dark:prose-p:text-foreground" />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
