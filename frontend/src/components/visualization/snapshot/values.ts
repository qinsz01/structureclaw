import type { VisualizationVector3 } from '../types'

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function asStringId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

export function getByPath(source: Record<string, unknown> | null, path: string): unknown {
  if (!source) {
    return null
  }
  const segments = path.split('.')
  let current: unknown = source
  for (const segment of segments) {
    const record = asRecord(current)
    if (!record) {
      return null
    }
    current = record[segment]
  }
  return current
}

export function pickNumber(source: Record<string, unknown> | null, keys: string[]) {
  if (!source) return null
  for (const key of keys) {
    const value = asNumber(key.includes('.') ? getByPath(source, key) : source[key])
    if (value !== null) {
      return value
    }
  }
  return null
}

export function pickNodeCoordinate(node: Record<string, unknown> | null, axis: 'x' | 'y' | 'z') {
  return node ? asNumber(node[axis]) : null
}

export function pickElementNodeIds(element: Record<string, unknown> | null): string[] | null {
  if (!element || !Array.isArray(element.nodes)) {
    return null
  }
  const normalized = element.nodes.map((value) => asStringId(value))
  if (normalized.some((value) => value === null)) {
    return null
  }
  return normalized as string[]
}

export function vectorMagnitude(values: Array<number | null | undefined>) {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (filtered.length === 0) {
    return 0
  }
  return Math.sqrt(filtered.reduce((sum, value) => sum + value ** 2, 0))
}

export function parseVector3(value: unknown): VisualizationVector3 | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null
  }
  const [x, y, z] = value.map((component) => asNumber(component))
  return x !== null && y !== null && z !== null ? { x, y, z } : null
}

export function parseRestraints(value: unknown): boolean[] | null | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value) || value.length !== 6 || !value.every((entry) => typeof entry === 'boolean')) {
    return null
  }
  return [...value]
}

export function compactNumberRecord<T extends string>(entries: Array<[T, number | null]>) {
  return Object.fromEntries(entries.filter(([, value]) => value !== null)) as Partial<Record<T, number>>
}
