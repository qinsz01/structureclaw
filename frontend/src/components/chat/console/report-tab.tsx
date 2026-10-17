import { FileText, Maximize2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { API_BASE } from '@/lib/api-base'
import { MarkdownBody } from '../markdown-body'
import { SeismicVisualReport } from '../seismic-visual-report'
import type { AgentResult } from './types'

export function ReportTabContent({
  result,
  t,
  locale,
}: {
  result: AgentResult
  t: (key: MessageKey) => string
  locale: AppLocale
}) {
  const reportMarkdown = result?.report?.markdown?.trim()
  const reportSummary = result?.report?.summary?.trim()
  const reportPdfUrl = (result?.report as Record<string, unknown>)?.pdfUrl as string | undefined
  return (
    <div className="space-y-4">
      <SeismicVisualReport result={result} t={t} locale={locale} />

      {reportPdfUrl && (
        <Card className="border-border\70 bg-card\85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileText className="h-5 w-5 text-cyan-500 dark:text-cyan-300" />
              {t('calculationBookPdf')}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5 dark:border-white/10">
              <span className="text-xs font-medium text-muted-foreground">PDF</span>
              <button
                type="button"
                onClick={() => window.open(`${API_BASE}${reportPdfUrl}`, '_blank')}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Maximize2 className="h-3 w-3" />
                {locale === 'zh' ? '全屏查看' : 'Fullscreen'}
              </button>
            </div>
            <iframe
              src={`${API_BASE}${reportPdfUrl}`}
              className="h-[600px] w-full border-0"
              title="PDF Preview"
            />
          </CardContent>
        </Card>
      )}

      {reportSummary && (
        <Card className="border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileText className="h-5 w-5 text-cyan-500 dark:text-cyan-300" />
              {t('reportSummary')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MarkdownBody content={reportSummary} />
          </CardContent>
        </Card>
      )}

      <Card className="border-border/70 bg-card/85 text-foreground shadow-none dark:border-white/10 dark:bg-slate-950/50">
        <CardHeader>
          <CardTitle className="text-lg">{t('markdownReport')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('markdownReportDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reportMarkdown ? (
            <article>
              <MarkdownBody content={reportMarkdown} />
            </article>
          ) : (
            <div className="rounded-2xl border border-dashed border-border/70 bg-background/70 p-6 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">
              {t('noReportBody')}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
