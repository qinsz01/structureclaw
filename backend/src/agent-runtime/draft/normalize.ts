/**
 * Shared draft normalizers. Each value class has exactly one implementation here.
 *
 * Two number parsers intentionally coexist because their call paths have always accepted
 * different inputs and changing either would change persisted drafts:
 * - `normalizeNumber` (flat legacy fields): `parseFloat` prefix parsing ("12m" -> 12) plus
 *   Chinese numerals ("六" -> 6).
 * - `finiteNumber` (canonical engineeringDraft fields): the whole string must be a number.
 * Likewise `normalizePositiveInteger` rejects values that round to 0 while `positiveInteger`
 * clamps any positive value to at least 1.
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

function parseChineseNumber(text: string): number | undefined {
  const chineseDigits: Record<string, number> = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
  };

  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Handle single character digits (零, 一, 二, 三, etc.)
  if (trimmed.length === 1) {
    const value = chineseDigits[trimmed];
    return value !== undefined ? value : undefined;
  }

  // Handle compound numbers like 二十二, 三层, 十五
  let result = 0;
  let temp = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const value = chineseDigits[char];

    if (value === undefined) {
      // Skip non-Chinese-numeral characters (like "层", "楼", etc.)
      continue;
    }

    if (value === 10) {
      // "十" acts as a multiplier for tens place
      if (temp === 0) {
        temp = 10;
      } else {
        result += temp * 10;
        temp = 0;
      }
    } else if (value < 10) {
      // Regular digit
      if (temp >= 10) {
        // Previous was a tens multiplier
        temp = temp + value;
      } else if (temp > 0) {
        // Previous digit exists, multiply and add
        result += temp;
        temp = value;
      } else {
        temp = value;
      }
    }
  }

  result += temp;

  // Handle cases like "十" (10) alone or at the end
  if (trimmed === '十') return 10;

  return result > 0 ? result : undefined;
}

/** Lenient: `parseFloat` prefix parsing with a Chinese-numeral fallback (flat legacy fields). */
export function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // First try standard number parsing
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    // Fall back to Chinese numeral parsing
    const chineseResult = parseChineseNumber(trimmed);
    if (chineseResult !== undefined && chineseResult > 0) {
      return chineseResult;
    }
  }
  return undefined;
}

/** Lenient integer; values that round to zero are rejected. */
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
