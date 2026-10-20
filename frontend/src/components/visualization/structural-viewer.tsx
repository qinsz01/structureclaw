'use client'

import { useEffect, useMemo, useRef, useState, useReducer, type ReactNode } from 'react'
import type { MessageKey } from '@/lib/i18n'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { cn, formatNumber, formatResultNumber } from '@/lib/utils'
import { viewerButtonClass } from './button-style'
import { getBucklingModes, BucklingModePanel } from './extensions'
import { VisualizationModalShell } from './modal-shell'
import { StructuralScene } from './structural-scene'
import { getMemberDisplacementMagnitude, getElementMetric, getResultPeak, getNodeReactionMagnitude, getNodeReactionMomentMagnitude, isForceComponent, isMomentMetric, forceMetricLabel, isLoadVisible, type ForceMetric } from './structural-scene-utils'
import type { SceneExportHandle } from './structural-scene'
import { VisualizationToolbar } from './toolbar'
import { createVizState, queryMatchesView, vizReducer, type VizState } from './state'
import { NativeStationPanel } from './native-station-panel'
import type { VisualizationCase, VisualizationLoad, VisualizationSnapshot, VisualizationViewMode } from './types'

function getCaseLabel(caseId: string, fallbackLabel: string, t: (key: MessageKey) => string) {
  if (caseId === 'model') return t('visualizationSourceModel')
  if (caseId === 'result') return t('visualizationSourceResult')
  if (caseId === 'envelope') return t('visualizationEnvelope')
  return fallbackLabel
}

function withUnit(value: string, unit?: string) {
  return unit ? `${value} ${unit}` : value
}

function getLoadUnit(load: VisualizationLoad, snapshot: VisualizationSnapshot | null) {
  if (load.kind === 'area') return snapshot?.floorLoadUnit
  if (load.kind === 'distributed') return snapshot?.distributedLoadUnit
  if (load.kind === 'moment') return snapshot?.momentUnit
  return snapshot?.nodalLoadUnit
}

function getLoadAreaUnit(snapshot: VisualizationSnapshot | null) {
  const lengthUnit = snapshot?.lengthUnit || snapshot?.nodeLabelUnit
  return lengthUnit ? `${lengthUnit}^2` : undefined
}

function getLoadTargetLabel(load: VisualizationLoad, t: (key: MessageKey) => string) {
  if (load.kind === 'area') {
    return `${load.label || load.storyId || '-'} · ${t('visualizationOriginalFloorAreaLoad')}`
  }
  if (load.elementId) {
    return `${load.elementId || '-'} · ${t('visualizationElementsList')}`
  }
  return `${load.nodeId || '-'} · ${t('visualizationNodesList')}`
}

function getLoadListLabel(load: VisualizationLoad) {
  if (load.kind === 'area') {
    return `${load.label || load.storyId || '-'} · A`
  }
  if (load.kind === 'distributed') {
    return `${load.elementId || '-'} · q`
  }
  if (load.kind === 'moment') {
    return `${load.nodeId || load.elementId || '-'} · M`
  }
  return `${load.nodeId || load.elementId || '-'} · P`
}

function getFloorLoadComponentLabel(type: string, t: (key: MessageKey) => string) {
  const normalized = type.toLowerCase()
  if (normalized === 'dead') return t('visualizationDeadLoad')
  if (normalized === 'live') return t('visualizationLiveLoad')
  if (normalized === 'other') return t('visualizationOtherLoad')
  return type
}

function getCaseMaxDisplacementMagnitude(activeCase: VisualizationCase | null) {
  if (!activeCase) {
    return 0
  }
  return Object.values(activeCase.nodeResults).reduce((max, result) => {
    const magnitude = activeCase.kind === 'envelope'
      ? Number(result.envelope?.maxAbsDisplacement || 0)
      : Math.sqrt((result.displacement?.ux || 0) ** 2 + (result.displacement?.uy || 0) ** 2 + (result.displacement?.uz || 0) ** 2)
    return Math.max(max, magnitude)
  }, Math.max(0, ...Object.keys(activeCase.memberResponses || {}).map((id) => getMemberDisplacementMagnitude(activeCase, id))))
}

function getModelSpan(snapshot: VisualizationSnapshot | null) {
  if (!snapshot || snapshot.nodes.length < 2) {
    return 0
  }
  const xs = snapshot.nodes.map((node) => node.position.x)
  const ys = snapshot.nodes.map((node) => node.position.y)
  const zs = snapshot.nodes.map((node) => node.position.z)
  const dx = Math.max(...xs) - Math.min(...xs)
  const dy = Math.max(...ys) - Math.min(...ys)
  const dz = Math.max(...zs) - Math.min(...zs)
  return Math.max(dx, dy, dz)
}

function roundStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0.1
  }
  if (value >= 100) return 10
  if (value >= 10) return 1
  if (value >= 1) return 0.1
  return 0.01
}

export type StructuralViewerProps = {
  embedded?: boolean
  fullscreen?: boolean
  onFullscreenChange?: (fullscreen: boolean) => void
  responseKey?: string
  onViewChange?: (value: Pick<VizState, 'view' | 'component'>) => void
  onSelectObject?: (object: { kind: 'node' | 'member'; id: string }) => void
  selectedPositionM?: number
  initialView?: VisualizationViewMode
  initialForceMetric?: ForceMetric
  figureKey?: string
  onChangeCase?: () => void
  queryResult?: ReactNode
  querySelection?: { field: string; component: string }
  queryBusy?: boolean
  queryObjectKinds?: ('node' | 'member')[]
  selectedObject?: { kind: 'node' | 'member'; id: string }
  onQueryObject?: (object: { kind: 'node' | 'member'; id: string }, quantity: { field: string; component: string }) => void
  open: boolean
  snapshot: VisualizationSnapshot | null
  locale: AppLocale
  onClose: () => void
  t: (key: MessageKey) => string
}

export function StructuralViewer({
  embedded, fullscreen, onFullscreenChange, responseKey, onViewChange, onSelectObject, selectedPositionM,
  selectedObject, onQueryObject, queryObjectKinds, initialView, initialForceMetric, figureKey, onChangeCase, queryResult, querySelection, queryBusy,
  open,
  snapshot,
  locale,
  onClose,
  t,
}: StructuralViewerProps) {
  const [state, dispatch] = useReducer(vizReducer, undefined, () => createVizState())
  const patch = (patch: Partial<VizState>) => dispatch({ type: 'patch', patch })
  const { view, component: forceMetric, deformScale: deformationScale, showOriginal: showUndeformed,
    showNodeLabels, showElementLabels, showLoads, showLegend, mode: bucklingModeIndex, resetToken } = state
  const selectedNodeId = state.selection?.kind === 'node' ? state.selection.id : null
  const selectedElementId = state.selection?.kind === 'member' ? state.selection.id : null
  const selectedLoadIndex = state.selection?.kind === 'load' ? Number(state.selection.id) : null
  const select = (kind: 'node' | 'member' | 'load', id: string | number | null) => {
    if ((queryBusy && onSelectObject) || id === null || (kind !== 'load' && queryObjectKinds && !queryObjectKinds.includes(kind))) return
    patch({ selection: { kind, id: String(id) } })
    if (kind !== 'load') onSelectObject?.({ kind, id: String(id) })
  }
  const setSelectedNodeId = (id: string | null) => select('node', id)
  const setSelectedElementId = (id: string | null) => select('member', id)
  const setSelectedLoadIndex = (id: number | null) => select('load', id)
  const plane = snapshot?.plane ?? 'xz'
  const [isExporting, setIsExporting] = useState(false)
  const exportRef = useRef<SceneExportHandle | null>(null)
  const placeholderTitle = useMemo(
    () => snapshot?.title || t('visualizationTitle'),
    [snapshot, t]
  )
  const activeCase = useMemo<VisualizationCase | null>(
    () => snapshot?.cases.find((item) => item.id === snapshot.defaultCaseId) || null,
    [snapshot]
  )
  const bucklingModes = useMemo(() => getBucklingModes(snapshot, activeCase), [snapshot, activeCase])
  const caseSnapshot = useMemo(() => snapshot && activeCase?.availableViews
    ? { ...snapshot, availableViews: activeCase.availableViews } : snapshot, [snapshot, activeCase])
  const selectedNode = useMemo(
    () => snapshot?.nodes.find((item) => item.id === selectedNodeId) || null,
    [selectedNodeId, snapshot]
  )
  const selectedElement = useMemo(
    () => snapshot?.elements.find((item) => item.id === selectedElementId) || null,
    [selectedElementId, snapshot]
  )
  const selectedNodeResults = activeCase && selectedNode ? activeCase.nodeResults[selectedNode.id] || null : null
  const selectedElementResults = activeCase && selectedElement ? activeCase.elementResults[selectedElement.id] || null : null
  const selectedMemberResponse = activeCase && selectedElement ? activeCase.memberResponses?.[selectedElement.id] : undefined
  const selectedLoad = selectedLoadIndex !== null && snapshot?.loads ? snapshot.loads[selectedLoadIndex] || null : null
  const selectedElementNodeIds = selectedElement?.nodeIds || []
  const modelOnly = snapshot?.source === 'model'
  const displacementDisplayFactor = snapshot?.displacementDisplayFactor || 1
  const formatForce = (value: number, component: ForceMetric) => formatResultNumber(value, locale, getResultPeak(activeCase, 'forces', component))
  const queryTarget = view === 'forces' && selectedElementId && isForceComponent(forceMetric) ? { field: 'forces', component: forceMetric }
    : view === 'reactions' && selectedNodeId ? { field: 'reactions', component: 'fz' }
    : view === 'deformed' && selectedNodeId ? { field: 'displacements', component: 'uz' } : null
  const deformationScaleRange = useMemo(() => {
    const modelSpan = getModelSpan(snapshot)
    const maxDisplacement = getCaseMaxDisplacementMagnitude(activeCase)
    if (modelSpan <= 0 || maxDisplacement <= 0) {
      return { min: 1, max: 40, step: 0.1, recommended: 12 }
    }

    const recommendedRaw = (modelSpan * 0.15) / maxDisplacement
    const recommended = Math.min(200000, Math.max(1, recommendedRaw))
    const min = Math.max(1, recommended / 20)
    const max = Math.max(40, recommended * 20)
    const step = roundStep((max - min) / 300)
    return { min, max, step, recommended }
  }, [snapshot, activeCase])

  useEffect(() => {
    if (!open || !snapshot) return
    dispatch({ type: 'open', key: figureKey ?? `${snapshot.source}:${snapshot.title}:${snapshot.defaultCaseId}`, initial: {
      view: initialView && (activeCase?.availableViews ?? snapshot.availableViews).includes(initialView) ? initialView : 'model',
      component: initialForceMetric ?? (snapshot.cases.some(item => Object.values(item.memberResponses ?? {}).some(row => row.samples.some(sample => typeof sample.M2 === 'number'))) ? 'M2' : 'moment'),
      deformScale: deformationScaleRange.recommended,
      selection: selectedObject ? { kind: selectedObject.kind, id: selectedObject.id } : null,
    } })
  }, [open, snapshot, activeCase, figureKey, initialView, initialForceMetric, selectedObject, deformationScaleRange.recommended])

  useEffect(() => {
    if (selectedObject) dispatch({ type: 'patch', patch: { selection: selectedObject } })
  }, [selectedObject?.kind, selectedObject?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!responseKey) return
    dispatch({ type: 'patch', patch: { view: initialView ?? 'model', component: initialForceMetric ?? 'M2' } })
    // Only a new selector response requests a view. Scene picks and subsequent
    // manual view changes must not replay that request.
  }, [responseKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = figureKey ?? `${snapshot?.source}:${snapshot?.title}:${snapshot?.defaultCaseId}`
    if (caseSnapshot && state.figureKey === key && !caseSnapshot.availableViews.includes(view)) dispatch({ type: 'patch', patch: { view: 'model' } })
  }, [caseSnapshot, figureKey, snapshot, state.figureKey, view])

  useEffect(() => { onViewChange?.({ view, component: forceMetric }) }, [onViewChange, view, forceMetric])

  return (
    <VisualizationModalShell
      embedded={embedded}
      fullscreen={fullscreen}
      onFullscreenChange={onFullscreenChange}
      onClose={onClose}
      onResetView={() => patch({ resetToken: resetToken + 1, selection: null })}
      onCameraChange={camera => patch({ camera, resetToken: resetToken + 1 })}
      onViewChange={view => patch({ view })}
      open={open}
      selectedCamera={state.camera}
      selectedView={view}
      snapshot={caseSnapshot}
      t={t}
      title={placeholderTitle}
      aside={
        <div className="space-y-4">
          <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('visualizationCurrentCase')}</div>
            <div className="mt-2 text-base font-semibold text-foreground">
              {activeCase ? getCaseLabel(activeCase.id, activeCase.label, t) : t('visualizationUnavailable')}
            </div>
            {onChangeCase && <button type="button" className="mt-2 text-sm text-foreground underline" onClick={onChangeCase}>{t('visualizationChangeCase')}</button>}
            {activeCase?.resultStatus === 'unavailable' ? <div className="mt-2 text-sm text-muted-foreground">{t('visualizationUnavailable')}</div> : null}
          </div>
          {onQueryObject && queryTarget && (selectedNodeId && (!queryObjectKinds || queryObjectKinds.includes('node')) || selectedElementId && (!queryObjectKinds || queryObjectKinds.includes('member'))) && <button type="button"
            disabled={queryBusy} className={cn('w-full rounded-lg px-3 py-2 text-sm', viewerButtonClass())}
            onClick={() => onQueryObject(selectedNodeId ? { kind: 'node', id: selectedNodeId } : { kind: 'member', id: selectedElementId! }, queryTarget)}>
            {t('visualizationQueryObject')}
          </button>}
          {queryResult && (!querySelection || queryMatchesView(querySelection, view, forceMetric)) && <div role="status" data-testid="visualization-query-result" className="rounded-lg border border-border bg-background p-3 text-sm">{queryResult}</div>}
          {snapshot?.statusMessage ? (
            <div className="rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm leading-6 text-foreground">
              {snapshot.statusMessage}
            </div>
          ) : null}
          {view === 'buckling' && bucklingModes.length ? (
            <BucklingModePanel
              modes={bucklingModes}
              activeIndex={bucklingModeIndex}
              title={t('visualizationViewBuckling')}
              onSelect={bucklingModes.length > 1 ? mode => patch({ mode }) : undefined}
            />
          ) : null}
          {snapshot?.unsupportedElementTypes.length ? (
            <div className="rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm leading-6 text-foreground">
              {t('visualizationUnsupportedElements')}: {snapshot.unsupportedElementTypes.join(', ')}
            </div>
          ) : null}
          {snapshot ? (
            <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('visualizationUnits')}</div>
              <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                <div>{t('visualizationUnitSystem')}: {snapshot.unitSystem || 'SI'}</div>
                <div>{t('visualizationLength')}: {snapshot.lengthUnit || snapshot.nodeLabelUnit || '-'}</div>
                {view === 'deformed' && <div>{t('visualizationDisplacement')}: {snapshot.displacementUnit || '-'}</div>}
                {['forces', 'reactions'].includes(view) && <div>{t('visualizationReactions')}: {snapshot.resultUnit || '-'}</div>}
                {['forces', 'reactions'].includes(view) && <div>{t('visualizationForceMoment')}: {snapshot.momentUnit || '-'}</div>}
                {view === 'model' && showLoads && <div>{t('visualizationLoadsList')}: {snapshot.nodalLoadUnit || '-'}</div>}
                {view === 'model' && showLoads && snapshot.loads.some(load => load.kind === 'distributed') && <div>{t('visualizationDistributedUnit')}: {snapshot.distributedLoadUnit || '-'}</div>}
                {view === 'model' && showLoads && snapshot.loads.some(load => load.kind === 'area') && <div>{t('visualizationAreaUnit')}: {snapshot.floorLoadUnit || '-'}</div>}
              </div>
            </div>
          ) : null}
          {selectedNode ? (
            <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('visualizationSelectedNode')}</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{selectedNode.id}</div>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <div>X: {withUnit(formatNumber(selectedNode.position.x, locale), snapshot?.lengthUnit || snapshot?.nodeLabelUnit)}</div>
                <div>Y: {withUnit(formatNumber(selectedNode.position.y, locale), snapshot?.lengthUnit || snapshot?.nodeLabelUnit)}</div>
                <div>Z: {withUnit(formatNumber(selectedNode.position.z, locale), snapshot?.lengthUnit || snapshot?.nodeLabelUnit)}</div>
                {selectedNode.restraints?.length ? (
                  <div>
                    {t('visualizationSupportRestraints')}: {selectedNode.restraints
                      .map((value, index) => `${['ux', 'uy', 'uz', 'rx', 'ry', 'rz'][index]}=${value ? '1' : '0'}`)
                      .join(' ')}
                  </div>
                ) : null}
                {!modelOnly && selectedNodeResults?.displacement && (
                  <div>
                    {t('visualizationViewDeformed')}: {withUnit(formatResultNumber(
                      Math.sqrt(
                        (selectedNodeResults.displacement.ux || 0) ** 2 +
                        (selectedNodeResults.displacement.uy || 0) ** 2 +
                        (selectedNodeResults.displacement.uz || 0) ** 2
                      ) * displacementDisplayFactor,
                      locale, getCaseMaxDisplacementMagnitude(activeCase) * displacementDisplayFactor
                    ), snapshot?.displacementUnit || snapshot?.nodeLabelUnit)}
                  </div>
                )}
                {!modelOnly && selectedNodeResults?.reaction && (
                  <>
                    <div>
                      {t('visualizationViewReactions')}: {withUnit(formatResultNumber(
                        Math.sqrt(
                          (selectedNodeResults.reaction.fx || 0) ** 2 +
                          (selectedNodeResults.reaction.fy || 0) ** 2 +
                          (selectedNodeResults.reaction.fz || 0) ** 2
                        ),
                        locale, Math.max(0, ...Object.keys(activeCase!.nodeResults).map(id => getNodeReactionMagnitude(activeCase!, id)))
                      ), snapshot?.resultUnit)}
                    </div>
                    <div>
                      {t('visualizationForceMoment')}: {withUnit(formatResultNumber(
                        Math.sqrt(
                          (selectedNodeResults.reaction.mx || 0) ** 2 +
                          (selectedNodeResults.reaction.my || 0) ** 2 +
                          (selectedNodeResults.reaction.mz || 0) ** 2
                        ),
                        locale, Math.max(0, ...Object.keys(activeCase!.nodeResults).map(id => getNodeReactionMomentMagnitude(activeCase!, id)))
                      ), snapshot?.momentUnit)}
                    </div>
                  </>
                )}
                {!modelOnly && selectedNodeResults?.envelope?.controlCase && (
                  <div>{t('visualizationControlCase')}: {String(selectedNodeResults.envelope.controlCase)}</div>
                )}
              </div>
            </div>
          ) : null}
          {selectedElement ? (
            <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('visualizationSelectedElement')}</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{selectedElement.id}</div>
              <div className="mt-1 text-sm text-muted-foreground">{selectedElement.type}</div>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                <div>{t('visualizationConnectedNodes')}: {selectedElementNodeIds.join(' - ')}</div>
                {!modelOnly && selectedMemberResponse && (
                  <div>{t(selectedMemberResponse.state === 'force-only' ? 'visualizationMemberForceOnly'
                    : selectedMemberResponse.state === 'native-stations' ? 'visualizationMemberNativeStations'
                    : selectedMemberResponse.state === 'recovered' ? 'visualizationMemberRecovered'
                    : selectedMemberResponse.state === 'truss' ? 'visualizationMemberTruss'
                    : selectedMemberResponse.state === 'interpolated' ? 'visualizationMemberInterpolated'
                    : 'visualizationMemberUnavailable')}</div>
                )}
                {!modelOnly && typeof selectedElementResults?.axial === 'number' && <div>{t('visualizationForceAxial')}: {withUnit(formatForce(selectedElementResults.axial, 'axial'), snapshot?.resultUnit)}</div>}
                {!modelOnly && typeof selectedElementResults?.shear === 'number' && <div>{t('visualizationForceShear')}: {withUnit(formatForce(selectedElementResults.shear, 'shear'), snapshot?.resultUnit)}</div>}
                {!modelOnly && typeof selectedElementResults?.moment === 'number' && <div>{t('visualizationForceMoment')}: {withUnit(formatForce(selectedElementResults.moment, 'moment'), snapshot?.momentUnit)}</div>}
                {!modelOnly && activeCase && isForceComponent(forceMetric) && <div>{forceMetricLabel(forceMetric, t)} · {t('visualizationForceSampled')}: {
                  getElementMetric(activeCase, selectedElement.id, forceMetric) === null ? t('visualizationMemberUnavailable')
                    : withUnit(formatForce(getElementMetric(activeCase, selectedElement.id, forceMetric)!, forceMetric), isMomentMetric(forceMetric) ? snapshot?.momentUnit : snapshot?.resultUnit)
                }</div>}
                {!modelOnly && !isForceComponent(forceMetric) && selectedElementResults?.controlCases?.[forceMetric] && (
                  <div>{t('visualizationControlCase')}: {selectedElementResults.controlCases[forceMetric]}</div>
                )}
                {!modelOnly && selectedMemberResponse?.state === 'native-stations' && (
                  <NativeStationPanel response={selectedMemberResponse} locale={locale} snapshot={snapshot!} component={forceMetric} t={t} />
                )}
              </div>
            </div>
          ) : null}
          {selectedLoad ? (
            <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('visualizationSelectedLoad')}</div>
              <div className="mt-2 text-sm text-muted-foreground">{getLoadTargetLabel(selectedLoad, t)}</div>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                {selectedLoad.kind === 'area' ? (
                  <>
                    <div>{t('visualizationFloorLoadIntensity')}: {withUnit(formatNumber(selectedLoad.intensity ?? Math.abs(selectedLoad.vector.z), locale), snapshot?.floorLoadUnit)}</div>
                    {typeof selectedLoad.area === 'number' ? (
                      <div>{t('visualizationFloorLoadArea')}: {withUnit(formatNumber(selectedLoad.area, locale), getLoadAreaUnit(snapshot))}</div>
                    ) : null}
                    {selectedLoad.components?.length ? (
                      <div>
                        {t('visualizationFloorLoadComponents')}: {selectedLoad.components.map((component) =>
                          `${getFloorLoadComponentLabel(component.type, t)} ${withUnit(formatNumber(component.value, locale), snapshot?.floorLoadUnit)}`
                        ).join(', ')}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {selectedLoad.position !== undefined ? <div>{t('visualizationMemberLoadPosition')}: {withUnit(formatNumber(selectedLoad.position, locale), snapshot?.lengthUnit)}</div> : null}
                    {selectedLoad.start !== undefined && selectedLoad.end !== undefined ? <div>{t('visualizationMemberLoadInterval')}: {formatNumber(selectedLoad.start, locale)} – {withUnit(formatNumber(selectedLoad.end, locale), snapshot?.lengthUnit)}</div> : null}
                    <div>
                      {t('visualizationReferenceFrame')}: {t(
                        selectedLoad.referenceFrame === 'element-local'
                          ? 'visualizationElementLocalFrame'
                          : 'visualizationGlobalFrame'
                      )}
                    </div>
                    {selectedLoad.referenceFrame === 'element-local' && selectedLoad.sourceVector ? (
                      <div>
                        {t('visualizationLocalComponents')}: {formatNumber(selectedLoad.sourceVector.x, locale)} / {formatNumber(selectedLoad.sourceVector.y, locale)} / {formatNumber(selectedLoad.sourceVector.z, locale)}
                      </div>
                    ) : null}
                    <div>X: {withUnit(formatNumber(selectedLoad.vector.x, locale), getLoadUnit(selectedLoad, snapshot))}</div>
                    <div>Y: {withUnit(formatNumber(selectedLoad.vector.y, locale), getLoadUnit(selectedLoad, snapshot))}</div>
                    <div>Z: {withUnit(formatNumber(selectedLoad.vector.z, locale), getLoadUnit(selectedLoad, snapshot))}</div>
                    {selectedLoad.endVector ? <div>{t('visualizationEndComponents')}: {formatNumber(selectedLoad.endVector.x, locale)} / {formatNumber(selectedLoad.endVector.y, locale)} / {withUnit(formatNumber(selectedLoad.endVector.z, locale), getLoadUnit(selectedLoad, snapshot))}</div> : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
          {snapshot ? (
            <div className="rounded-2xl border border-border/70 bg-card/80 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t('visualizationObjectList')}</div>
                {state.selection && <button
                  className="rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                  onClick={() => {
                    patch({ selection: null })
                  }}
                  type="button"
                >
                  {t('visualizationClearSelection')}
                </button>}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('visualizationNodesList')}</div>
                  <div className="flex max-h-28 flex-wrap gap-2 overflow-auto">
                    {snapshot.nodes.map((node) => (
                      <button
                        key={node.id}
                        className={`rounded-full border px-3 py-1.5 text-xs transition ${selectedNodeId === node.id ? 'border-primary bg-primary/15 text-foreground' : 'border-border/70 bg-background/70 text-muted-foreground hover:text-foreground'}`}
                        onClick={() => {
                          setSelectedNodeId(node.id)
                          setSelectedElementId(null)
                          setSelectedLoadIndex(null)
                        }}
                        type="button"
                      >
                        {node.id}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('visualizationElementsList')}</div>
                  <div className="flex max-h-28 flex-wrap gap-2 overflow-auto">
                    {snapshot.elements.map((element) => (
                      <button
                        key={element.id}
                        className={`rounded-full border px-3 py-1.5 text-xs transition ${selectedElementId === element.id ? 'border-primary bg-primary/15 text-foreground' : 'border-border/70 bg-background/70 text-muted-foreground hover:text-foreground'}`}
                        onClick={() => {
                          setSelectedElementId(element.id)
                          setSelectedNodeId(null)
                          setSelectedLoadIndex(null)
                        }}
                        type="button"
                      >
                        {element.id}
                      </button>
                    ))}
                  </div>
                </div>
                {view === 'model' && showLoads && snapshot.loads.length > 0 ? (
                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('visualizationLoadsList')}</div>
                    <div className="flex max-h-28 flex-wrap gap-2 overflow-auto">
                      {snapshot.loads.map((load, index) => activeCase && isLoadVisible(snapshot, activeCase, load) ? (
                        <button
                          key={`${load.caseId || 'default'}-${load.nodeId || load.elementId || load.storyId || index}-${index}`}
                          className={`rounded-full border px-3 py-1.5 text-xs transition ${selectedLoadIndex === index ? 'border-primary bg-primary/15 text-foreground' : 'border-border/70 bg-background/70 text-muted-foreground hover:text-foreground'}`}
                          onClick={() => {
                            setSelectedLoadIndex(index)
                            setSelectedNodeId(null)
                            setSelectedElementId(null)
                          }}
                          type="button"
                        >
                          {getLoadListLabel(load)}
                        </button>
                      ) : null)}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {!selectedNode && !selectedElement && !selectedLoad && (
            <div className="rounded-2xl border border-border/70 bg-card/80 p-4 text-sm leading-6 text-muted-foreground">
              {snapshot ? `${t('visualizationSceneSelectionHelp')} ${t('visualizationSceneClickEmpty')}` : t('visualizationMissingModel')}
            </div>
          )}
        </div>
      }
    >
      {snapshot && activeCase ? (
        <div className="flex h-full min-h-0 flex-col">
          <VisualizationToolbar snapshot={caseSnapshot || snapshot} state={state} scaleRange={deformationScaleRange} onChange={patch} t={t} />
          <div className="flex items-center justify-end border-b border-border px-4 py-2">
            <button className={cn('rounded-full px-3 py-1.5 text-sm', viewerButtonClass())}
              disabled={isExporting} type="button" onClick={() => {
                setIsExporting(true)
                exportRef.current?.exportPng(snapshot.title.replace(/[^a-z0-9_-]/gi, '_'), 2, () => setIsExporting(false))
              }}>{t('visualizationExportPng')}</button>
          </div>
          <div className="min-h-0 flex-1" data-testid="visualization-modal-scene">
            <StructuralScene
              activeCase={activeCase}
              bucklingModeIndex={bucklingModeIndex}
              deformationScale={deformationScale}
              diagramScale={state.diagramScale}
              cameraPreset={state.camera}
              preserveCameraOnResize={embedded}
              locale={locale}
              onFit={() => patch({ resetToken: resetToken + 1, selection: null })}
              exportRef={exportRef}
              forceMetric={forceMetric}
              onSelectElement={setSelectedElementId}
              onSelectLoad={setSelectedLoadIndex}
              onSelectNode={setSelectedNodeId}
              onClearSelection={() => {
                patch({ selection: null })
              }}
              resetToken={resetToken}
              plane={plane}
              selectedElementId={selectedElementId}
              selectedPositionM={selectedPositionM}
              selectedLoadIndex={selectedLoadIndex}
              selectedNodeId={selectedNodeId}
              showElementLabels={showElementLabels}
              showLegend={showLegend}
              showLoads={view === 'model' && showLoads}
              showNodeLabels={showNodeLabels}
              showUndeformed={showUndeformed}
              snapshot={snapshot}
              t={t}
              view={view}
            />
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center justify-center px-6 py-10 text-center" data-testid="visualization-modal-placeholder">
          <div className="max-w-xl rounded-[28px] border border-dashed border-primary bg-primary/15 p-8">
            <div className="text-sm uppercase tracking-[0.24em] text-primary">{t('visualizationTitle')}</div>
            <div className="mt-3 text-2xl font-semibold text-foreground">{t('visualizationUnavailable')}</div>
            <div className="mt-3 text-sm leading-6 text-muted-foreground">{t('visualizationMissingModel')}</div>
          </div>
        </div>
      )}
    </VisualizationModalShell>
  )
}
