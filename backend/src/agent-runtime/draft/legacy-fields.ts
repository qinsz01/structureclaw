/**
 * Historical flat draft field names (part of the draft boundary, re-exported by `boundary.ts`).
 *
 * Old conversations, LLM patches and diagnostics still name values with flat scalars such as
 * `lengthM` or `frameConcreteGrade`. These tables map those names onto canonical
 * `engineeringDraft` locations. They name locations only, never engineering defaults or answers.
 * Kept as a leaf module so diagnostics and the boundary can both read it without an import cycle.
 */
import { draftContract, type FieldSchema } from '../../engineering/draft-contract.js';
import { fieldTokens } from '../../engineering/field-path.js';

const object = (properties: FieldSchema): FieldSchema => ({ type: 'object', properties, additionalProperties: false });
const choice = (...values: string[]): FieldSchema => ({ type: 'string', enum: values });
const integer = { type: 'integer', minimum: 1 };

/** Flat alias -> canonical draft path. */
export const legacyDraftPaths: Record<string, string> = {
  ...Object.fromEntries(Object.keys(draftContract.properties.geometry.properties).map(key => [key, `geometry.${key}`])),
  supportType: 'boundary.supportType', frameBaseSupportType: 'boundary.frameBaseSupportType',
  frameDimension: 'coordinateSystem.dimension',
  frameMaterial: 'material.grade', frameConcreteGrade: 'material.grade', frameRebarGrade: 'material.rebarGrade',
  frameBeamSection: 'sections.beam', frameColumnSection: 'sections.column',
  elements: 'topology.members', nodes: 'topology.nodes',
};

/** Flat-only fields that have no canonical location; validated with this schema. */
export const legacyDraftContract = object({
  loadKN: { type: 'number' }, loadPositionM: { type: 'number', minimum: 0 }, spanLengthM: { type: 'number', exclusiveMinimum: 0 },
  loadType: choice('point', 'distributed'), loadPosition: choice('end', 'midspan', 'full-span', 'top-nodes', 'middle-joint', 'free-joint'),
  frameDimension: choice('2d', '3d'),
  ...Object.fromEntries(['storyCount', 'bayCount', 'bayCountX', 'bayCountY'].map(key => [key, integer])),
});

/** Flat views of canonical loads; they must not outlive a withdrawn `loads` entry. */
const LEGACY_LOAD_SCALARS = ['loadKN', 'loadType', 'loadPosition', 'loadPositionM', 'floorLoads'];

/** Field path in canonical spelling: strips `engineeringDraft.` and resolves a flat alias root. */
export function canonicalDraftPath(field: string): string {
  const path = field.replace(/^engineeringDraft\./, '');
  const root = fieldTokens(path)[0]?.key;
  return root && legacyDraftPaths[root] ? legacyDraftPaths[root] + path.slice(root.length) : path;
}

/** Canonical draft values overlaid with flat scalars where the draft omits them (read-only view). */
export function withLegacyScalarViews(state: Record<string, unknown>): Record<string, unknown> {
  // Historical scalar fields are read only at the compatibility boundary.
  const result: Record<string, any> = { ...state, ...((state.engineeringDraft as Record<string, unknown> | undefined) ?? {}) };
  for (const [old, path] of Object.entries(legacyDraftPaths)) {
    if (state[old] === undefined || !path.includes('.')) continue;
    const [owner, key] = path.split('.');
    result[owner!] = { [key!]: state[old], ...(result[owner!] ?? {}) };
  }
  return result;
}

/** Flat keys that shadow a removed canonical path and must be removed with it. */
export function legacyScalarsShadowing(path: string, overlaps: (a: string, b: string) => boolean): string[] {
  const aliases = Object.entries(legacyDraftPaths)
    .filter(([, canonical]) => overlaps(canonical, path) || overlaps(path, canonical))
    .map(([alias]) => alias);
  return fieldTokens(path)[0]?.key === 'loads' ? [...aliases, ...LEGACY_LOAD_SCALARS] : aliases;
}
