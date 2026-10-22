/** Shared draft normalizers. Numeric fields accept complete finite numeric values.
 * Natural-language quantities must be interpreted by the LLM before this boundary.
 */
import type {
  DraftFloorLoad,
  DraftIssue,
  DraftLoadPosition,
  DraftLoadType,
  DraftSupportType,
  DraftWindParams,
  EngineeringDraftLoad,
  FrameBaseSupportType,
  FrameDimension,
  InferredModelType,
} from '../../shared/types/agent.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Strict: the complete string must be a finite number. */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function firstPositiveNumber(candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    const parsed = positiveNumber(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Any positive value, rounded and clamped to at least 1. */
export function positiveInteger(value: unknown): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.round(parsed));
}

export function positiveNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => positiveNumber(item))
    .filter((item): item is number => item !== undefined);
  return values.length ? values : undefined;
}

export function nonNegativeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => finiteNumber(item))
    .filter((item): item is number => item !== undefined && item >= 0);
  return values.length ? values : undefined;
}

/** Legacy flat fields use the same strict numeric boundary as canonical fields. */
export function normalizeNumber(value: unknown): number | undefined {
  return finiteNumber(value);
}

/** Numeric integer input; values that round to zero are rejected. */
export function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = normalizeNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : undefined;
}

export function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => normalizeNumber(item))
    .filter((item): item is number => item !== undefined && item > 0);
  return normalized.length > 0 ? normalized : undefined;
}

// ---------------------------------------------------------------------------
// Enumerations. Exact-match on the raw value; callers that accept padded strings
// pass `normalizeString(value)` first.
// ---------------------------------------------------------------------------

export function normalizeLoadType(value: unknown): DraftLoadType | undefined {
  return value === 'point' || value === 'distributed' ? value : undefined;
}

export function normalizeSupportType(value: unknown): DraftSupportType | undefined {
  return value === 'cantilever' || value === 'simply-supported' || value === 'fixed-fixed' || value === 'fixed-pinned'
    ? value
    : undefined;
}

export function normalizeLoadPosition(value: unknown): DraftLoadPosition | undefined {
  if (
    value === 'end'
    || value === 'midspan'
    || value === 'full-span'
    || value === 'top-nodes'
    || value === 'middle-joint'
    || value === 'free-joint'
  ) {
    return value;
  }
  return undefined;
}

export function normalizeLoadPositionM(value: unknown): number | undefined {
  const parsed = normalizeNumber(value);
  if (parsed === undefined || parsed < 0) {
    return undefined;
  }
  return parsed;
}

export function normalizeInferredType(value: unknown): InferredModelType | undefined {
  if (value === 'beam' || value === 'column' || value === 'truss' || value === 'portal-frame' || value === 'double-span-beam' || value === 'frame' || value === 'unknown') {
    return value;
  }
  return undefined;
}

export function normalizeFrameDimension(value: unknown): FrameDimension | undefined {
  return value === '2d' || value === '3d' ? value : undefined;
}

export function normalizeFrameBaseSupportType(value: unknown): FrameBaseSupportType | undefined {
  return value === 'fixed' || value === 'pinned' ? value : undefined;
}

/** Terrain class "A".."D"; accepts lower case, padding and a trailing "类". */
export function normalizeWindTerrainRoughness(value: unknown): DraftWindParams['terrainRoughness'] | undefined {
  const raw = normalizeString(value)?.toUpperCase().replace(/类$/, '');
  return raw === 'A' || raw === 'B' || raw === 'C' || raw === 'D' ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

export function isLineLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'line' || load.kind === 'distributed' || load.unit === 'kN/m';
}

export function isPointLikeLoad(load: EngineeringDraftLoad): boolean {
  return load.kind === 'point' || load.kind === 'nodal' || load.unit === 'kN';
}

export function normalizeFloorLoads(value: unknown): DraftFloorLoad[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const shouldInferMissingStory = !value.some((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    const row = item as Record<string, unknown>;
    return row.story !== undefined && row.story !== null;
  });
  const normalized = value
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const row = item as Record<string, unknown>;
      const hasExplicitStory = row.story !== undefined && row.story !== null;
      const story = hasExplicitStory
        ? normalizePositiveInteger(row.story)
        : shouldInferMissingStory ? index + 1 : undefined;
      if (!story) {
        return null;
      }
      const verticalKN = normalizeNumber(row.verticalKN);
      const liveLoadKN = normalizeNumber(row.liveLoadKN);
      const lateralXKN = normalizeNumber(row.lateralXKN);
      const lateralYKN = normalizeNumber(row.lateralYKN);
      if (verticalKN === undefined && liveLoadKN === undefined && lateralXKN === undefined && lateralYKN === undefined) {
        return null;
      }
      return { story, verticalKN, liveLoadKN, lateralXKN, lateralYKN };
    });
  const filtered = normalized.filter((item) => item !== null) as DraftFloorLoad[];
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Story-keyed floor-load merge: each `override` component replaces the `base` component of the
 * same story, omitted components are kept. Both inputs must be non-empty; the result is sorted.
 */
export function mergeFloorLoadsByStory(base: DraftFloorLoad[], override: DraftFloorLoad[]): DraftFloorLoad[] {
  const merged = new Map<number, DraftFloorLoad>();
  for (const load of base) {
    merged.set(load.story, { ...load });
  }
  for (const load of override) {
    const current = merged.get(load.story);
    merged.set(load.story, {
      story: load.story,
      verticalKN: load.verticalKN ?? current?.verticalKN,
      liveLoadKN: load.liveLoadKN ?? current?.liveLoadKN,
      lateralXKN: load.lateralXKN ?? current?.lateralXKN,
      lateralYKN: load.lateralYKN ?? current?.lateralYKN,
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.story - right.story);
}

// ---------------------------------------------------------------------------
// Diagnostics and skill state
// ---------------------------------------------------------------------------

export function normalizeSkillState(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
}

export function normalizeDraftIssues(value: unknown): DraftIssue[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const issues = value
    .map((item): DraftIssue | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const severity = record.severity;
      const reason = record.reason;
      if (
        severity !== 'invalid'
        && severity !== 'ambiguous'
        && severity !== 'unrealistic'
        && severity !== 'conflict'
      ) {
        return null;
      }
      if (typeof reason !== 'string' || !reason.trim()) {
        return null;
      }
      return {
        ...(typeof record.field === 'string' && record.field.trim() ? { field: record.field.trim() } : {}),
        ...(record.kind === 'missing' || record.kind === 'confirmation' ? { kind: record.kind } : {}),
        ...(typeof record.target === 'string' ? { target: record.target } : {}),
        ...(record.value !== undefined ? { value: record.value } : {}),
        severity,
        reason: reason.trim(),
        ...(typeof record.question === 'string' && record.question.trim() ? { question: record.question.trim() } : {}),
      };
    })
    .filter((item): item is DraftIssue => item !== null);
  return issues.length ? issues : undefined;
}

/** String entries of `skillState.invalidDraftFields`; non-strings are ignored. */
export function invalidDraftFieldsOf(state: { skillState?: Record<string, unknown> } | undefined): string[] {
  const fields = state?.skillState?.invalidDraftFields;
  return Array.isArray(fields) ? fields.filter((field): field is string => typeof field === 'string') : [];
}
