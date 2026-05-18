'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

type Point = [number, number]
type Line = [number, number, number, number]

type DetachedHouseDesign = {
  floors?: Array<Record<string, unknown>>
  global_constraints?: Record<string, unknown>
  issues?: Array<Record<string, unknown>>
}

type NormalizedFloor = Record<string, unknown> & {
  id: string
  outline: Point[]
}

type LayerKey = 'outline' | 'rooms' | 'walls' | 'doors' | 'windows' | 'columns' | 'beams' | 'zones' | 'issues'

const LAYERS: Array<{ key: LayerKey; label: string }> = [
  { key: 'outline', label: 'Outline' },
  { key: 'rooms', label: 'Rooms' },
  { key: 'walls', label: 'Walls' },
  { key: 'doors', label: 'Doors' },
  { key: 'windows', label: 'Windows' },
  { key: 'columns', label: 'Columns' },
  { key: 'beams', label: 'Beams' },
  { key: 'zones', label: 'Zones' },
  { key: 'issues', label: 'Issues' },
]

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  outline: true,
  rooms: true,
  walls: true,
  doors: true,
  windows: true,
  columns: true,
  beams: true,
  zones: true,
  issues: true,
}

export function DetachedHousePlanViewer({ design }: { design: DetachedHouseDesign }) {
  const floors = useMemo(() => normalizeFloors(design), [design])
  const [selectedFloorId, setSelectedFloorId] = useState(() => floors[0]?.id || '')
  const [layers, setLayers] = useState(DEFAULT_LAYERS)
  const floor = floors.find((item) => item.id === selectedFloorId) ?? floors[0]
  const bounds = useMemo(() => computeGlobalBounds(floors, design), [floors, design])

  if (!floor) {
    return (
      <div className="border-t border-border/30 px-3 py-3 text-xs text-muted-foreground">
        No detached-house floor data available.
      </div>
    )
  }

  return (
    <div className="border-t border-border/30 bg-background/70 px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {floors.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSelectedFloorId(item.id)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] transition-colors',
              item.id === floor.id
                ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200'
                : 'border-border/60 text-muted-foreground hover:text-foreground',
            )}
          >
            {item.id}
          </button>
        ))}
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {LAYERS.map((layer) => (
          <label key={layer.key} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              checked={layers[layer.key]}
              onChange={(event) => setLayers((current) => ({ ...current, [layer.key]: event.target.checked }))}
              className="h-3 w-3 accent-cyan-600"
            />
            {layer.label}
          </label>
        ))}
      </div>
      <svg
        aria-label="Detached house plan preview"
        className="h-[300px] w-full rounded-md border border-border/60 bg-white dark:bg-slate-950"
        viewBox="0 0 1000 650"
        role="img"
      >
        <rect x="0" y="0" width="1000" height="650" className="fill-white dark:fill-slate-950" />
        {layers.zones ? drawZones(design, floor.id, bounds) : null}
        {layers.rooms ? drawRooms(floor, bounds) : null}
        {layers.outline ? drawPolygon(floor.outline, bounds, 'fill-none stroke-slate-950 dark:stroke-slate-100', 5) : null}
        {layers.walls ? drawWalls(floor, bounds) : null}
        {layers.beams ? drawLines(floor.beams, bounds, 'stroke-violet-600 dark:stroke-violet-300', 4) : null}
        {layers.columns ? drawColumns(floor, bounds) : null}
        {layers.doors || layers.windows ? drawOpenings(floor, bounds, layers) : null}
        {layers.issues ? drawIssues(design, floor.id, bounds) : null}
      </svg>
    </div>
  )
}

function normalizeFloors(design: DetachedHouseDesign) {
  return (Array.isArray(design.floors) ? design.floors : [])
    .filter((floor): floor is Record<string, unknown> => Boolean(floor && typeof floor === 'object'))
    .map((floor) => ({
      ...floor,
      id: String(floor.id || ''),
      outline: normalizePolygon(floor.outline),
    }) as NormalizedFloor)
    .filter((floor) => floor.id && floor.outline.length >= 3)
}

function normalizePolygon(value: unknown): Point[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(Array.isArray)
    .map((point) => [Number(point[0]), Number(point[1])] as Point)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
}

function normalizeLine(value: unknown): Line | null {
  if (!Array.isArray(value) || value.length < 4) return null
  const line = value.slice(0, 4).map(Number) as Line
  return line.every(Number.isFinite) ? line : null
}

function computeGlobalBounds(floors: NormalizedFloor[], design: DetachedHouseDesign) {
  const points: Point[] = []
  for (const floor of floors) {
    points.push(...floor.outline)
    for (const room of arrayRecords(floor.rooms)) points.push(...normalizePolygon(room.polygon))
    for (const wall of arrayRecords(floor.walls)) {
      const line = normalizeLine(wall.line)
      if (line) points.push([line[0], line[1]], [line[2], line[3]])
    }
    for (const beam of arrayRecords(floor.beams)) {
      const line = normalizeLine(beam.line)
      if (line) points.push([line[0], line[1]], [line[2], line[3]])
    }
    for (const column of arrayRecords(floor.columns)) {
      const x = Number(column.x)
      const y = Number(column.y)
      if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y])
    }
  }
  for (const zone of allZones(design)) points.push(...normalizePolygon(zone.polygon))
  if (points.length === 0) points.push([0, 0], [1000, 1000])
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { minX, maxX: maxX === minX ? minX + 1 : maxX, minY, maxY: maxY === minY ? minY + 1 : maxY }
}

function mapPoint(point: Point, bounds: ReturnType<typeof computeGlobalBounds>): Point {
  const pad = 34
  const width = 1000 - pad * 2
  const height = 650 - pad * 2
  const scale = Math.min(width / (bounds.maxX - bounds.minX), height / (bounds.maxY - bounds.minY))
  const drawnWidth = (bounds.maxX - bounds.minX) * scale
  const drawnHeight = (bounds.maxY - bounds.minY) * scale
  const offsetX = pad + (width - drawnWidth) / 2
  const offsetY = pad + (height - drawnHeight) / 2
  return [
    offsetX + (point[0] - bounds.minX) * scale,
    650 - (offsetY + (point[1] - bounds.minY) * scale),
  ]
}

function pointsAttr(points: Point[], bounds: ReturnType<typeof computeGlobalBounds>) {
  return points.map((point) => mapPoint(point, bounds).join(',')).join(' ')
}

function drawPolygon(points: Point[], bounds: ReturnType<typeof computeGlobalBounds>, className: string, strokeWidth = 1) {
  if (points.length < 3) return null
  return <polygon points={pointsAttr(points, bounds)} className={className} strokeWidth={strokeWidth} vectorEffect="non-scaling-stroke" />
}

function drawRooms(floor: Record<string, unknown>, bounds: ReturnType<typeof computeGlobalBounds>) {
  return arrayRecords(floor.rooms).map((room, index) => {
    const polygon = normalizePolygon(room.polygon)
    if (polygon.length < 3) return null
    const centroid = polygon.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]] as Point, [0, 0]).map((v) => v / polygon.length) as Point
    const [x, y] = mapPoint(centroid, bounds)
    return (
      <g key={String(room.id || index)}>
        {drawPolygon(polygon, bounds, 'fill-cyan-500/12 stroke-cyan-700/50 dark:stroke-cyan-300/60', 1.5)}
        <text x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-slate-700 text-[20px] dark:fill-slate-200">
          {String(room.name || room.type || room.id || '')}
        </text>
      </g>
    )
  })
}

function drawWalls(floor: Record<string, unknown>, bounds: ReturnType<typeof computeGlobalBounds>) {
  return arrayRecords(floor.walls).map((wall, index) => {
    const line = normalizeLine(wall.line)
    if (!line) return null
    const [x1, y1] = mapPoint([line[0], line[1]], bounds)
    const [x2, y2] = mapPoint([line[2], line[3]], bounds)
    const kind = String(wall.kind || wall.type || '')
    const exterior = kind === 'exterior'
    const virtual = kind === 'virtual'
    return (
      <line
        key={String(wall.id || index)}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className={virtual ? 'stroke-slate-400/50' : exterior ? 'stroke-slate-950 dark:stroke-slate-100' : 'stroke-slate-600 dark:stroke-slate-300'}
        strokeWidth={virtual ? 2 : exterior ? 6 : 3}
        strokeDasharray={virtual ? '8 8' : undefined}
        vectorEffect="non-scaling-stroke"
      />
    )
  })
}

function drawLines(items: unknown, bounds: ReturnType<typeof computeGlobalBounds>, className: string, width: number) {
  return arrayRecords(items).map((item, index) => {
    const line = normalizeLine(item.line)
    if (!line) return null
    const [x1, y1] = mapPoint([line[0], line[1]], bounds)
    const [x2, y2] = mapPoint([line[2], line[3]], bounds)
    return <line key={String(item.id || index)} x1={x1} y1={y1} x2={x2} y2={y2} className={className} strokeWidth={width} vectorEffect="non-scaling-stroke" />
  })
}

function drawColumns(floor: Record<string, unknown>, bounds: ReturnType<typeof computeGlobalBounds>) {
  return arrayRecords(floor.columns).map((column, index) => {
    const x = Number(column.x)
    const y = Number(column.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const [cx, cy] = mapPoint([x, y], bounds)
    return <rect key={String(column.id || index)} x={cx - 5} y={cy - 5} width="10" height="10" className="fill-amber-500 stroke-amber-900" />
  })
}

function drawOpenings(floor: Record<string, unknown>, bounds: ReturnType<typeof computeGlobalBounds>, layers: Record<LayerKey, boolean>) {
  const walls = new Map(arrayRecords(floor.walls).map((wall) => [String(wall.id || ''), normalizeLine(wall.line)]))
  return arrayRecords(floor.openings).map((opening, index) => {
    const kind = String(opening.type || opening.kind || '')
    if (kind === 'door' && !layers.doors) return null
    if (kind === 'window' && !layers.windows) return null
    const wallLine = walls.get(String(opening.wall_id || ''))
    if (!wallLine) return null
    const width = Number(opening.width) || 900
    const length = Math.hypot(wallLine[2] - wallLine[0], wallLine[3] - wallLine[1]) || 1
    const rawOffset = opening.offset ?? opening.start
    const defaultOffset = Math.max(0, (length - width) / 2)
    const offset = Number.isFinite(Number(rawOffset)) ? Number(rawOffset) : defaultOffset
    const start = Math.max(0, Math.min(length, offset))
    const t1 = Math.max(0, Math.min(1, start / length))
    const t2 = Math.max(0, Math.min(1, (start + width) / length))
    const p1: Point = [wallLine[0] + (wallLine[2] - wallLine[0]) * t1, wallLine[1] + (wallLine[3] - wallLine[1]) * t1]
    const p2: Point = [wallLine[0] + (wallLine[2] - wallLine[0]) * t2, wallLine[1] + (wallLine[3] - wallLine[1]) * t2]
    const [x1, y1] = mapPoint(p1, bounds)
    const [x2, y2] = mapPoint(p2, bounds)
    return (
      <line
        key={String(opening.id || index)}
        data-opening-id={String(opening.id || index)}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        className={kind === 'window' ? 'stroke-sky-500' : 'stroke-emerald-500'}
        strokeWidth={7}
        vectorEffect="non-scaling-stroke"
      />
    )
  })
}

function drawZones(design: DetachedHouseDesign, floorId: string, bounds: ReturnType<typeof computeGlobalBounds>) {
  return allZones(design)
    .filter((zone) => !Array.isArray(zone.floor_ids) || zone.floor_ids.includes(floorId))
    .map((zone, index) => (
      <g key={String(zone.id || index)}>
        {drawPolygon(normalizePolygon(zone.polygon), bounds, zone.kind === 'no_column_zones' ? 'fill-rose-500/10 stroke-rose-500/40' : 'fill-lime-500/10 stroke-lime-500/40', 1)}
      </g>
    ))
}

function drawIssues(design: DetachedHouseDesign, floorId: string, bounds: ReturnType<typeof computeGlobalBounds>) {
  return (Array.isArray(design.issues) ? design.issues : [])
    .filter((issue) => !issue.floor_id || issue.floor_id === floorId)
    .map((issue, index) => {
      const polygon = normalizePolygon(issue.polygon)
      if (polygon.length >= 3) return <g key={String(issue.id || index)}>{drawPolygon(polygon, bounds, 'fill-rose-500/15 stroke-rose-500', 2)}</g>
      return null
    })
}

function allZones(design: DetachedHouseDesign): Array<Record<string, unknown> & { kind?: string }> {
  const constraints = design.global_constraints || {}
  return ['stair_zones', 'wet_zones', 'no_column_zones'].flatMap((kind) =>
    arrayRecords(constraints[kind]).map((zone) => ({ ...zone, kind })),
  )
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []
}
