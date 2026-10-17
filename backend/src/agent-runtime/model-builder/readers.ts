/** Lenient readers for skill-state values used by the template model builders. */
import type { FrameBaseSupportType } from '../../shared/types/agent.js';
import { PINNED_RESTRAINT, FIXED_RESTRAINT } from '../../engineering/coordinate-semantics.js';

export function buildFixedRestraint(baseSupport: FrameBaseSupportType): boolean[] {
  if (baseSupport === 'pinned') {
    return [...PINNED_RESTRAINT];
  }
  return [...FIXED_RESTRAINT];
}

export function accumulateCoordinates(lengths: number[]): number[] {
  const coordinates = [0];
  for (const value of lengths) {
    coordinates.push(coordinates[coordinates.length - 1] + value);
  }
  return coordinates;
}

export function readSignedNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readPositiveNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0);
  return values.length > 0 ? values : undefined;
}

export function readNonNegativeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0);
  return values.length > 0 ? values : undefined;
}

export function addCoordinate(coordinates: Set<number>, value: number | undefined, length: number): void {
  if (value === undefined || value <= 0 || value >= length) {
    return;
  }
  coordinates.add(Number(value.toFixed(9)));
}

export function roundCoordinate(value: number): number {
  return Number(value.toFixed(9));
}

export function coordinateMatches(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9;
}

export function readRecordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  return records.length ? records : undefined;
}

export function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readPositiveNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.round(parsed));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
