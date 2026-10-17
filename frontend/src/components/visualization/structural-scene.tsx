'use client'

import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { getBucklingModes, getVisualizationExtensionByView } from './extensions'
import { getMemberDisplacementMagnitude, getElementMetric, forceMetricLabel, isMomentMetric, getNodeReactionMagnitude, getNodeReactionMomentMagnitude, getNodeDisplacementMagnitude } from './structural-scene-utils'
import type { SceneExportHandle, StructuralSceneProps } from './scene/types'

export type { SceneExportHandle } from './scene/types'
import { ColorBar } from './scene/color-bar'
import { BucklingAnimator } from './scene/buckling'
import { PngExporter } from './scene/controllers'
import { SceneContent } from './scene/scene-content'

export function StructuralScene(props: StructuralSceneProps) {
  const { snapshot, activeCase, forceMetric, view, showLegend, t, exportRef, bucklingModeIndex } = props

  // Internal ref to the gl renderer; populated by PngExporter inside Canvas
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const invalidateRef = useRef<(() => void) | null>(null)
  // Shared amplitude ref for buckling animation — written by BucklingAnimator, read by BucklingMember
  const bucklingAmplitudeRef = useRef<number>(0)

  // Expose exportPng via the forwarded ref
  useEffect(() => {
    if (!exportRef) return
    const handle: SceneExportHandle = {
      exportPng: (filename = 'structureclaw-scene', scale = 1, onDone?: () => void) => {
        const gl = glRef.current
        const invalidate = invalidateRef.current
        if (!gl) return
        if (scale === 1) {
          // 1x: just capture current frame
          if (invalidate) invalidate()
          requestAnimationFrame(() => {
            const dataUrl = gl.domElement.toDataURL('image/png')
            const link = document.createElement('a')
            link.href = dataUrl
            link.download = `${filename}.png`
            link.click()
            onDone?.()
          })
          return
        }
        // 2x / 4x: temporarily upscale the renderer
        const origW = gl.domElement.width
        const origH = gl.domElement.height
        const origRatio = gl.getPixelRatio()
        gl.setPixelRatio(origRatio * scale)
        gl.setSize(origW / origRatio, origH / origRatio, false)
        if (invalidate) invalidate()
        requestAnimationFrame(() => {
          const dataUrl = gl.domElement.toDataURL('image/png')
          // restore
          gl.setPixelRatio(origRatio)
          gl.setSize(origW / origRatio, origH / origRatio, false)
          if (invalidate) invalidate()
          const link = document.createElement('a')
          link.href = dataUrl
          link.download = `${filename}@${scale}x.png`
          link.click()
          onDone?.()
        })
      },
    }
    exportRef.current = handle
    return () => {
      exportRef.current = null
    }
  }, [exportRef])

  const webglAvailable = useMemo(() => {
    if (typeof document === 'undefined') {
      return false
    }
    if (process.env.NODE_ENV === 'test') {
      return false
    }
    try {
      const canvas = document.createElement('canvas')
      return Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    } catch {
      return false
    }
  }, [])

  const rawMaxElementMetric = useMemo(
    () => Math.max(0, ...snapshot.elements.map((element) => Math.abs(getElementMetric(activeCase, element.id, forceMetric) ?? 0))),
    [activeCase, forceMetric, snapshot.elements]
  )
  const maxElementMetric = Math.max(1e-12, rawMaxElementMetric)
  const maxReaction = useMemo(
    () => Math.max(1, ...snapshot.nodes.map((node) => getNodeReactionMagnitude(activeCase, node.id))),
    [activeCase, snapshot.nodes]
  )
  const maxReactionMoment = useMemo(
    () => Math.max(1e-12, ...snapshot.nodes.map((node) => getNodeReactionMomentMagnitude(activeCase, node.id))),
    [activeCase, snapshot.nodes]
  )
  const maxDisplacement = useMemo(
    () => Math.max(1e-12, ...snapshot.nodes.map((node) => getNodeDisplacementMagnitude(activeCase, node.id)),
      ...snapshot.elements.map((element) => getMemberDisplacementMagnitude(activeCase, element.id))),
    [activeCase, snapshot.nodes, snapshot.elements]
  )
  const maxUtilization = useMemo(
    () => Math.max(1, ...snapshot.elements.map((element) => activeCase.elementResults[element.id]?.utilization ?? 0)),
    [activeCase, snapshot.elements]
  )

  const invalidElementReferenceCount = useMemo(() => {
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id))
    return snapshot.elements.filter((element) => !nodeIds.has(element.nodeIds[0]) || !nodeIds.has(element.nodeIds[1])).length
  }, [snapshot.elements, snapshot.nodes])

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      return
    }
    if (invalidElementReferenceCount <= 0) {
      return
    }
    console.warn('[Visualization] Some elements cannot be rendered because their node references do not exist in the node map.', {
      invalidElementReferenceCount,
      totalElements: snapshot.elements.length,
      totalNodes: snapshot.nodes.length,
    })
  }, [invalidElementReferenceCount, snapshot.elements.length, snapshot.nodes.length])

  const colorBarProps = useMemo(() => {
    if (view === 'forces') {
      if (rawMaxElementMetric <= 0) return null
      const metricLabel = `${forceMetricLabel(forceMetric, t)} · ${t('visualizationForceSampledMagnitude')}`
      const unit = isMomentMetric(forceMetric) ? snapshot.momentUnit : snapshot.resultUnit
      return { maxValue: maxElementMetric, label: metricLabel, unit }
    }
    if (view === 'reactions') {
      return { maxValue: maxReaction, label: t('visualizationReactions'), unit: snapshot.resultUnit }
    }
    if (view === 'deformed') {
      return {
        maxValue: maxDisplacement,
        valueScale: snapshot.displacementDisplayFactor || 1,
        label: t('visualizationDisplacement'),
        unit: snapshot.displacementUnit || snapshot.nodeLabelUnit,
      }
    }
    if (view === 'utilization') {
      return getVisualizationExtensionByView('utilization')?.getLegend?.({
        snapshot,
        activeCase,
        activeView: view,
        bucklingModeIndex: bucklingModeIndex ?? 0,
        forceMetric,
        t,
      }) || null
    }
    if (view === 'buckling') {
      const modes = getBucklingModes(snapshot, activeCase)
      if (modes?.length) {
        const mode = modes[bucklingModeIndex ?? 0] ?? modes[0]
        return {
          maxValue: mode.lambda,
          valueScale: 1,
          label: `λ${(bucklingModeIndex ?? 0) + 1}`,
          unit: '',
        }
      }
    }
    return null
  }, [view, forceMetric, maxElementMetric, rawMaxElementMetric, maxReaction, maxDisplacement, snapshot, activeCase, bucklingModeIndex, t])

  if (!webglAvailable) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-center" data-testid="visualization-scene-fallback">
        <div className="max-w-lg rounded-[28px] border border-dashed border-cyan-300/35 bg-cyan-300/8 p-8">
          <div className="text-sm uppercase tracking-[0.24em] text-cyan-700 dark:text-cyan-200">{props.t('visualizationTitle')}</div>
          <div className="mt-3 text-2xl font-semibold text-foreground">{props.t('visualizationLoadingScene')}</div>
          <div className="mt-3 text-sm leading-6 text-muted-foreground">{props.t('visualizationWebglFallback')}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.08),transparent_24%),linear-gradient(180deg,rgba(148,163,184,0.08),transparent_30%)]">
      {invalidElementReferenceCount > 0 && invalidElementReferenceCount === snapshot.elements.length && (
        <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-lg rounded-xl border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-xs text-amber-900 shadow-lg dark:text-amber-100">
          <div className="font-semibold">{t('visualizationElementReferenceMismatchTitle')}</div>
          <div className="mt-1 leading-5">{t('visualizationElementReferenceMismatchBody')}</div>
        </div>
      )}
      <Canvas dpr={[1, 1.75]} frameloop={view === 'buckling' ? 'always' : 'demand'} gl={{ preserveDrawingBuffer: true }} onPointerMissed={props.onClearSelection}>
        <PngExporter glRef={glRef} invalidateRef={invalidateRef} />
        {view === 'buckling' && <BucklingAnimator amplitudeRef={bucklingAmplitudeRef} />}
        <Suspense fallback={null}>
          <SceneContent {...props} maxElementMetric={maxElementMetric} rawMaxElementMetric={rawMaxElementMetric} maxReaction={maxReaction} maxReactionMoment={maxReactionMoment} maxDisplacement={maxDisplacement} maxUtilization={maxUtilization} bucklingAmplitudeRef={bucklingAmplitudeRef} />
        </Suspense>
      </Canvas>
      {showLegend && colorBarProps && (
        <ColorBar {...colorBarProps} show={true} />
      )}
    </div>
  )
}
