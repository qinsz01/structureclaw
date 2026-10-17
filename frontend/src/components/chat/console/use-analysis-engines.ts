import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/lib/api-base'
import type { AnalysisEngineSummary, EngineProbeResult } from './types'

/** Analysis engine list plus on-demand probe state for the composer status row. */
export function useAnalysisEngines() {
  const [allEngines, setAllEngines] = useState<AnalysisEngineSummary[]>([])
  const [probeResults, setProbeResults] = useState<Record<string, EngineProbeResult>>({})

  useEffect(() => {
    let active = true

    async function loadEngines() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/analysis-engines`)
        if (!response.ok || !active) return
        const payload = await response.json()
        if (!active || !Array.isArray(payload?.engines)) return
        const engines = (payload.engines as Record<string, unknown>[]).map((e) => ({
          id: String(e.id ?? ''),
          name: String(e.name ?? e.id ?? ''),
          available: Boolean(e.available),
          priority: Number(e.priority ?? 0),
          status: String(e.status ?? 'unknown'),
          unavailableReason: typeof e.unavailableReason === 'string' ? e.unavailableReason : undefined,
        }))
        setAllEngines(engines.sort((a, b) => b.priority - a.priority))
      } catch {
        if (active) {
          setAllEngines([])
        }
      }
    }

    loadEngines()
    return () => { active = false }
  }, [])

  const [probePopupOpen, setProbePopupOpen] = useState(false)
  const [probeAllRunning, setProbeAllRunning] = useState(false)
  const probeButtonRef = useRef<HTMLButtonElement>(null)

  async function probeAllEngines() {
    setProbeAllRunning(true)
    setProbePopupOpen(true)
    const initial: typeof probeResults = {}
    allEngines.forEach((e) => { initial[e.id] = { passed: false, loading: true } })
    setProbeResults(initial)

    let active = true

    await Promise.allSettled(
      allEngines.map(async (engine) => {
        try {
          const response = await fetch(`${API_BASE}/api/v1/analysis-engines/${encodeURIComponent(engine.id)}/probe`, { method: 'POST' })
          if (!response.ok) {
            const text = await response.text()
            if (active) setProbeResults((prev) => ({ ...prev, [engine.id]: { passed: false, error: text || `HTTP ${response.status}`, loading: false } }))
            return
          }
          const payload = await response.json()
          if (active) {
            setProbeResults((prev) => ({
              ...prev,
              [engine.id]: {
                passed: Boolean(payload.passed),
                durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
                error: typeof payload.error === 'string' ? payload.error : undefined,
                loading: false,
              },
            }))
          }
        } catch (err) {
          if (active) setProbeResults((prev) => ({ ...prev, [engine.id]: { passed: false, error: String(err), loading: false } }))
        }
      }),
    )

    if (active) setProbeAllRunning(false)
  }

  async function probeSingleEngine(engineId: string) {
    setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, loading: true } }))
    try {
      const response = await fetch(`${API_BASE}/api/v1/analysis-engines/${encodeURIComponent(engineId)}/probe`, { method: 'POST' })
      if (!response.ok) {
        const text = await response.text()
        setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, error: text || `HTTP ${response.status}`, loading: false } }))
        return
      }
      let payload: { passed?: unknown; durationMs?: unknown; error?: unknown }
      try {
        payload = await response.json()
      } catch {
        setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, error: 'Invalid JSON response', loading: false } }))
        return
      }
      setProbeResults((prev) => ({
        ...prev,
        [engineId]: {
          passed: Boolean(payload.passed),
          durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
          error: typeof payload.error === 'string' ? payload.error : undefined,
          loading: false,
        },
      }))
    } catch (err) {
      setProbeResults((prev) => ({ ...prev, [engineId]: { passed: false, error: String(err), loading: false } }))
    }
  }

  return {
    allEngines,
    probeResults,
    probePopupOpen,
    setProbePopupOpen,
    probeAllRunning,
    probeButtonRef,
    probeAllEngines,
    probeSingleEngine,
  }
}
