'use client'

import { Suspense, useEffect, useMemo, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { getVisualizationExtensionByView } from './extensions'
import { getMemberDisplacementMagnitude, getElementMetric, forceMetricLabel, isMomentMetric, getNodeReactionMagnitude, getNodeReactionMomentMagnitude, getNodeDisplacementMagnitude } from './structural-scene-utils'
import type { SceneExportHandle, StructuralSceneProps } from './scene/types'

export type { SceneExportHandle } from './scene/types'
import { ColorBar, type LegendProps } from './scene/color-bar'
import { useTheme } from 'next-themes'
import { ScenePaletteContext, scenePalettes } from './scene/palette'
import { exportSceneImage } from './scene/export-image'
import { BucklingAnimator } from './scene/buckling'
import { PngExporter } from './scene/controllers'
import { SceneContent } from './scene/scene-content'

export function StructuralScene(props: StructuralSceneProps) {
  const { resolvedTheme } = useTheme()
  const palette = scenePalettes[resolvedTheme === 'dark' ? 'dark' : 'light']
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<(() => number) | null>(null)
  const renderRef = useRef<(() => void) | null>(null)
  const { snapshot, activeCase, forceMetric, view, showLegend, t, exportRef, bucklingModeIndex } = props

  // Internal ref to the gl renderer; populated by PngExporter inside Canvas
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const invalidateRef = useRef<(() => void) | null>(null)
  // Shared amplitude ref for buckling animation — written by BucklingAnimator, read by BucklingMember
  const bucklingAmplitudeRef = useRef<number>(0)

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
    () => Math.max(0, ...snapshot.nodes.map((node) => getNodeReactionMagnitude(activeCase, node.id))),
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

  const colorBarProps = useMemo<LegendProps | null>(() => {
    if (view === 'forces') {
      const metricLabel = forceMetricLabel(forceMetric, t)
      const unit = isMomentMetric(forceMetric) ? snapshot.momentUnit : snapshot.resultUnit
      return { maxValue: rawMaxElementMetric, label: metricLabel, unit, colorMode: 'signed' }
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
    if (view === 'utilization' || view === 'buckling') {
      return getVisualizationExtensionByView(view)?.getLegend?.({
        snapshot,
        activeCase,
        activeView: view,
        bucklingModeIndex: bucklingModeIndex ?? 0,
        forceMetric,
        t,
      }) || null
    }
    return null
  }, [view, forceMetric, rawMaxElementMetric, maxReaction, maxDisplacement, snapshot, activeCase, bucklingModeIndex, t])

  useEffect(() => {
    if (!exportRef) return
    exportRef.current = { exportPng: (filename = 'structure', scale = 2, onDone) => {
      try {
        if (glRef.current && containerRef.current) exportSceneImage({ gl: glRef.current, render: () => renderRef.current?.(),
          container: containerRef.current, filename, scale, palette, legend: colorBarProps,
          title: snapshot.title,
          subtitle: snapshot.runId ? `${t('visualizationRun')} · ${snapshot.runId.slice(0, 8)}` : undefined,
          note: view === 'deformed' ? `${t('visualizationScale')}: ${props.deformationScale.toFixed(1)}×`
            : `${t('visualizationGeometryScale')}: ${snapshot.lengthUnit ?? ''}`,
          locale: props.locale ?? 'en', unitsPerPixel: measureRef.current?.(), lengthUnit: snapshot.lengthUnit })
      } finally { onDone?.() }
    } }
    return () => { exportRef.current = null }
  }, [exportRef, palette, colorBarProps, snapshot, activeCase, view, props.deformationScale, props.locale, t])

  if (!webglAvailable) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-center" data-testid="visualization-scene-fallback">
        <div className="max-w-lg rounded-[28px] border border-dashed border-primary bg-primary/15 p-8">
          <div className="text-sm uppercase tracking-[0.24em] text-primary">{props.t('visualizationTitle')}</div>
          <div className="mt-3 text-2xl font-semibold text-foreground">{props.t('visualizationLoadingScene')}</div>
          <div className="mt-3 text-sm leading-6 text-muted-foreground">{props.t('visualizationWebglFallback')}</div>
        </div>
      </div>
    )
  }

  return (
    <ScenePaletteContext.Provider value={palette}>
    <div ref={containerRef} className="flex h-full w-full flex-col" style={{ background: palette.background }} onDoubleClick={props.onFit}>
      {invalidElementReferenceCount > 0 && invalidElementReferenceCount === snapshot.elements.length && (
        <div className="pointer-events-none shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-foreground shadow-lg">
          <div className="font-semibold">{t('visualizationElementReferenceMismatchTitle')}</div>
          <div className="mt-1 leading-5">{t('visualizationElementReferenceMismatchBody')}</div>
        </div>
      )}
      {/* Keep scene UI outside the WebGL viewport so fit uses the unobstructed area. */}
      <div className="flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1 overflow-hidden">
      <Canvas dpr={[1, 1.75]} frameloop={view === 'buckling' ? 'always' : 'demand'} gl={{ preserveDrawingBuffer: true }} onPointerMissed={props.onClearSelection}>
        <PngExporter glRef={glRef} invalidateRef={invalidateRef} renderRef={renderRef} measureRef={measureRef} />
        {view === 'buckling' && <BucklingAnimator amplitudeRef={bucklingAmplitudeRef} />}
        <Suspense fallback={null}>
          <SceneContent {...props} maxElementMetric={maxElementMetric} rawMaxElementMetric={rawMaxElementMetric} maxReaction={maxReaction} maxReactionMoment={maxReactionMoment} maxDisplacement={maxDisplacement} bucklingAmplitudeRef={bucklingAmplitudeRef} />
        </Suspense>
      </Canvas>
      </div>
      {showLegend && colorBarProps && (
        <ColorBar {...colorBarProps} locale={props.locale} show={true} />
      )}
      </div>
      {view === 'reactions' && activeCase.kind === 'envelope' && <p className="shrink-0 rounded-lg bg-background p-3 text-sm text-foreground">{t('visualizationEnvelopeReactions')}</p>}
    </div>
    </ScenePaletteContext.Provider>
  )
}
