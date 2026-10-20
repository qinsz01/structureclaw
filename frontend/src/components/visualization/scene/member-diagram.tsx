import { useEffect, useMemo } from 'react'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import { formatResultNumber } from '@/lib/utils'
import { buildDiagram } from '../diagram'
import { isMomentMetric } from '../structural-scene-utils'
import type { VisualizationElement } from '../types'
import type { SceneRenderContext } from './render-context'
import { useScenePalette } from './palette'

export function MemberDiagram({ element, ctx }: { element: VisualizationElement; ctx: SceneRenderContext }) {
  const palette = useScenePalette()
  const { snapshot, activeCase, forceMetric, maxElementMetric, diagramScale = 1, locale = 'en', t } = ctx
  const span = Math.max(...['x', 'y', 'z'].map(axis => {
    const values = snapshot.nodes.map(node => node.position[axis as 'x' | 'y' | 'z'])
    return Math.max(...values) - Math.min(...values)
  }))
  const diagram = useMemo(() => buildDiagram(activeCase.memberResponses?.[element.id], element, forceMetric, maxElementMetric, span, diagramScale),
    [activeCase, element, forceMetric, maxElementMetric, span, diagramScale])
  const meshes = useMemo(() => [true, false].map(positive => {
    const geometry = new THREE.BufferGeometry()
    const vertices = diagram?.triangles.filter(triangle => triangle.positive === positive).flatMap(triangle => triangle.vertices) ?? []
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geometry.computeVertexNormals()
    return { geometry, color: positive ? palette.positive : palette.negative }
  }), [diagram, palette])
  useEffect(() => () => meshes.forEach(mesh => mesh.geometry.dispose()), [meshes])
  if (!diagram) return null
  const labels = [...new Set([diagram.samples[0], diagram.peak, diagram.samples[diagram.samples.length - 1]])]
  const unit = isMomentMetric(forceMetric) ? snapshot.momentUnit : snapshot.resultUnit
  return <group>
    {meshes.map(({ geometry, color }, index) => <mesh key={index} geometry={geometry}>
      <meshBasicMaterial color={color} side={THREE.DoubleSide} transparent opacity={0.6} depthWrite={false} />
    </mesh>)}
    <Line points={diagram.samples.map(sample => sample.tip)} color={palette.foreground} lineWidth={1.3} />
    {labels.map((sample, index) => <Html key={index} center position={sample.tip.toArray()} zIndexRange={[20, 0]}>
      <div data-viz-label data-testid={sample === diagram.peak ? 'diagram-peak' : 'diagram-end'}
        className="w-max whitespace-nowrap rounded-md border border-border bg-background/95 px-1.5 py-0.5 text-[10px] text-foreground">
        {sample === diagram.peak ? `${t('visualizationPeak')} · ` : ''}{formatResultNumber(sample.value, locale)} {unit}
      </div>
    </Html>)}
  </group>
}
