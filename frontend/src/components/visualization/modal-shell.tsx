'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Focus, Maximize2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { getVisualizationViewLabelKey } from './extensions'
import type { CameraPreset } from './state'
import type { VisualizationSnapshot, VisualizationViewMode } from './types'
import { viewerButtonClass } from './button-style'

type VisualizationModalShellProps = {
  embedded?: boolean
  fullscreen?: boolean
  onFullscreenChange?: (fullscreen: boolean) => void
  open: boolean
  snapshot: VisualizationSnapshot | null
  title: string
  selectedView: VisualizationViewMode
  selectedCamera: CameraPreset
  onViewChange: (mode: VisualizationViewMode) => void
  onCameraChange: (preset: CameraPreset) => void
  onClose: () => void
  onResetView: () => void
  t: (key: MessageKey) => string
  children: ReactNode
  aside?: ReactNode
}

const CAMERA_LABELS: Record<CameraPreset, MessageKey> = { front: 'visualizationCameraFront', side: 'visualizationCameraSide', top: 'visualizationCameraTop', iso: 'visualizationCameraIso' }
const CAMERA_OPTIONS: CameraPreset[] = ['front', 'side', 'top', 'iso']

export function VisualizationModalShell({
  embedded = false,
  fullscreen = false,
  onFullscreenChange,
  open,
  snapshot,
  title,
  selectedView,
  selectedCamera,
  onViewChange,
  onCameraChange,
  onClose,
  onResetView,
  t,
  children,
  aside,
}: VisualizationModalShellProps) {
  const inline = embedded && !fullscreen
  const inlineRef = useRef<HTMLDivElement>(null)
  // Move the portal host, not the React tree: canvas, orbit controls and viewer
  // state survive the fullscreen round trip.
  const [host] = useState(() => {
    if (typeof document === 'undefined') return null
    const element = document.createElement('div')
    element.className = 'h-full min-h-0'
    return element
  })
  useLayoutEffect(() => {
    if (!open || !host) return
    const target = inline ? inlineRef.current : document.body
    target?.appendChild(host)
    return () => { host.remove() }
  }, [host, inline, open])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const lastActiveElementRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => setCopyStatus(null), [open, snapshot?.runId])

  const availableViews = useMemo(
    (): VisualizationViewMode[] => snapshot?.availableViews || ['model'],
    [snapshot]
  )
  useEffect(() => {
    if (!open || inline) {
      return
    }

    lastActiveElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab' || !containerRef.current) {
        return
      }

      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute('disabled'))

      if (focusable.length === 0) {
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
      lastActiveElementRef.current?.focus()
    }
  }, [open, inline])

  if (!open || typeof document === 'undefined') {
    return null
  }

  return <>{embedded && <div ref={inlineRef} className="h-full min-h-0" data-testid="workspace-inline-figure" />}{host && createPortal(
    <div className={inline ? 'h-full min-h-0' : 'fixed inset-0 z-90'}>
      <button
        hidden={inline}
        aria-label={t('visualizationClose')}
        className="absolute inset-0 bg-foreground/60 backdrop-blur-xs"
        onClick={onClose}
        type="button"
      />
      <div className={inline ? 'h-full min-h-0' : 'absolute inset-0 p-2 sm:p-4'}>
        <div
          ref={containerRef}
          aria-modal={inline ? undefined : true}
          aria-label={t('visualizationTitle')}
          className="relative flex h-full flex-col overflow-hidden rounded-[30px] border border-border/70 bg-card/95 shadow-2xl backdrop-blur-xl"
          role={inline ? 'region' : 'dialog'}
        >
          <div className="pointer-events-none absolute inset-0 bg-background dark:bg-background" />
          <div className={cn('relative flex items-start justify-between gap-3 border-b border-border/70', inline ? 'flex-wrap px-3 py-2' : 'px-5 py-4')}>
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.24em] text-primary">{t('visualizationTitle')}</p>
              <h2 className={cn('mt-1 font-semibold text-foreground', inline ? 'text-base' : 'text-2xl')}>{title}</h2>
              {snapshot?.runId && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <button type="button" title={snapshot.runId} aria-label={t('visualizationCopyRunId')} data-testid="visualization-copy-run-id"
                  className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1', viewerButtonClass())}
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(snapshot.runId!); setCopyStatus('copied') }
                    catch { setCopyStatus('failed') }
                  }}>
                  {t('visualizationRun')} · {snapshot.runId.slice(0, 8)} <Copy className="h-3 w-3" />
                </button>
                {copyStatus && <span role="status" data-testid="visualization-run-copy-status">{t(copyStatus === 'copied' ? 'visualizationRunIdCopied' : 'visualizationRunIdCopyFailed')}</span>}
              </div>}
              {snapshot ? (
                <div className="mt-2 space-y-2 text-sm text-muted-foreground">
                  <p>
                    {snapshot.dimension}D · {snapshot.nodes.length} {t('analysisOverviewCountsNodes').toLowerCase()} · {snapshot.elements.length} {t('analysisOverviewCountsElements').toLowerCase()}
                  </p>
                  <div className={cn('flex flex-wrap items-center gap-2', inline && 'hidden')}>
                    <span className="rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-xs">
                      {t('visualizationStatusCurrentSource')}: {snapshot.source === 'model' ? t('visualizationSourceModel') : t('visualizationSourceResult')}
                    </span>
                    {snapshot.statusMessage ? (
                      <span className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-foreground">
                        {snapshot.statusMessage}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                className={cn('rounded-full', viewerButtonClass())}
                onClick={onResetView}
                type="button"
                variant="outline"
              >
                <Focus className="h-4 w-4" />
                {t('visualizationResetView')}
              </Button>
              <Button
                ref={closeButtonRef}
                className={cn('rounded-full', viewerButtonClass())}
                onClick={inline ? () => onFullscreenChange?.(true) : onClose}
                type="button"
                variant="outline"
              >
                {inline ? <Maximize2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
                {t(inline ? 'visualizationFullscreen' : 'visualizationClose')}
              </Button>
            </div>
          </div>

          <div className={cn('relative flex flex-col gap-2 border-b border-border/70', inline ? 'px-3 py-2' : 'px-5 py-4')}>
            <div className="flex flex-wrap items-center gap-2">
              {availableViews.length === 1 ? <span className="rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground">{t(getVisualizationViewLabelKey(availableViews[0]))}</span> : availableViews.map((view) => (
                <button
                  key={view}
                  className={cn(
                    'rounded-full px-4 py-2 text-sm', viewerButtonClass(selectedView === view)
                  )}
                  aria-pressed={selectedView === view}
                  onClick={() => onViewChange(view)}
                  type="button"
                >
                  {t(getVisualizationViewLabelKey(view))}
                </button>
              ))}
            </div>
            {snapshot?.dimension === 3 && <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('visualizationCamera')}</span>
              {CAMERA_OPTIONS.map((preset) => (
                <button
                  key={preset}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs font-medium', viewerButtonClass(selectedCamera === preset)
                  )}
                  aria-pressed={selectedCamera === preset}
                  onClick={() => onCameraChange(preset)}
                  type="button"
                >
                  {t(CAMERA_LABELS[preset])}
                </button>
              ))}
            </div>}
          </div>

          <div className={cn('relative flex min-h-0 flex-1 flex-col overflow-y-auto', !inline && 'xl:flex-row xl:overflow-hidden')}>
            <div className={cn('flex-1', inline ? 'min-h-[380px]' : 'min-h-[420px] xl:min-h-0')}>{children}</div>
            <aside className={cn('shrink-0 overflow-y-auto border-t border-border/70 bg-background/50', !inline && 'p-4 xl:w-[280px] xl:border-l xl:border-t-0')}>
              <details open={!inline || detailsOpen} onToggle={event => { if (inline) setDetailsOpen(event.currentTarget.open) }}>
                <summary className={inline ? 'cursor-pointer px-4 py-3 text-sm text-foreground' : 'hidden'}>{t('visualizationObjectDetails')}</summary>
                <div className={inline ? 'max-h-44 overflow-y-auto p-4 pt-0' : undefined}>{aside}</div>
              </details>
            </aside>
          </div>

          <div className="relative border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Maximize2 className="h-3.5 w-3.5" />
              <span>{t('visualizationDoubleClickHint')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    host
  )}</>
}
