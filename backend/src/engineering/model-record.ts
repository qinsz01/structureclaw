import { createHash } from 'node:crypto';

export type ModelRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is ModelRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(ordered);
    return items.length > 0 && items.every((item) => isRecord(item) && typeof item.id === 'string')
      ? items.sort((a, b) => String((a as ModelRecord).id).localeCompare(String((b as ModelRecord).id)))
      : items;
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, ordered(value[key])]));
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value)) ?? 'null').digest('hex');
}

export const nonPhysicalMetadataKeys = [
  'title', 'name', 'description', 'source', 'inputEvidence', 'createdAt', 'updatedAt', 'physicalModel', 'inferredType',
];

/** Display and source annotations do not change structural physics. */
export function modelHash(model: ModelRecord): string {
  const physical: ModelRecord = {};
  for (const key of [
    'schema_version', 'unit_system', 'coordinate_system', 'nodes', 'elements',
    'materials', 'sections', 'stories', 'load_cases', 'load_combinations',
    'analysis_control', 'site_seismic', 'structure_system', 'wind', 'wall_openings', 'slab_openings',
  ]) {
    if (model[key] !== undefined) physical[key] = model[key];
  }
  // Boundary readers still accept the historical load aliases.
  physical.load_cases ??= model.loadCases;
  physical.load_combinations ??= model.loadCombinations;
  if (isRecord(model.metadata)) {
    const metadata = Object.fromEntries(Object.entries(model.metadata).filter(([key]) => !nonPhysicalMetadataKeys.includes(key)));
    if (Object.keys(metadata).length) physical.metadata = metadata;
  }
  return contentHash(physical);
}
