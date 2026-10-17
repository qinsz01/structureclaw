import { createPortal } from 'react-dom'
import { Loader2, RefreshCw } from 'lucide-react'
import type { ConsoleState } from './use-console-state'

/** Engine probe results popover, portaled to document.body above the probe button. */
export function ProbeResultsPopup({ state }: { state: ConsoleState }) {
  const { probePopupOpen, probeResults, probeButtonRef, setProbePopupOpen, t, allEngines, probeSingleEngine } = state

  return (
    <>
      {probePopupOpen && Object.keys(probeResults).length > 0 && probeButtonRef.current && typeof window !== 'undefined' && createPortal(
        <>
          <div
            className="fixed inset-0 z-70"
            onClick={() => setProbePopupOpen(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setProbePopupOpen(false) }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('probeResultsDialogTitle')}
            className="fixed z-71 w-80 rounded-xl border border-border/70 bg-card p-4 shadow-xl dark:border-white/10 dark:bg-slate-950"
            style={{
              bottom: window.innerHeight - probeButtonRef.current.getBoundingClientRect().top + 8,
              left: Math.max(0, Math.min(probeButtonRef.current.getBoundingClientRect().left, window.innerWidth - 336)),
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setProbePopupOpen(false) }}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground">{t('engineProbeButton')}</span>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setProbePopupOpen(false)}
                aria-label={t('closeLabel')}
              >
                ✕
              </button>
            </div>
            <div className="space-y-2.5">
              {allEngines.map((engine) => {
                const probe = probeResults[engine.id]
                if (!probe) return null
                return (
                  <div key={engine.id} className="rounded-lg border border-border/50 bg-background/60 p-2.5 dark:border-white/5 dark:bg-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {probe.loading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                        ) : (
                          <span className={`inline-block h-2 w-2 rounded-full ${probe.passed ? 'bg-emerald-500' : 'bg-red-400'}`} />
                        )}
                        <span className="text-xs font-medium text-foreground">{engine.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {probe.loading ? t('engineProbeRunning')
                            : probe.passed ? t('engineProbePassed')
                            : t('engineProbeFailed')}
                        </span>
                        {!probe.loading && !probe.passed && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50 dark:text-cyan-300 dark:hover:bg-cyan-900/30"
                            onClick={() => probeSingleEngine(engine.id)}
                            aria-label={`${t('retryLabel')} ${engine.name}`}
                          >
                            <RefreshCw className="h-2.5 w-2.5" />
                            {t('retryLabel')}
                          </button>
                        )}
                      </div>
                    </div>
                    {probe.durationMs != null && !probe.loading && (
                      <div className="mt-1 text-[11px] text-muted-foreground">{t('engineProbeDuration')}: {probe.durationMs}ms</div>
                    )}
                    {probe.error && !probe.loading && (
                      <div className="mt-1 text-[11px] leading-4 text-red-600 dark:text-red-400" role="alert">{probe.error}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
