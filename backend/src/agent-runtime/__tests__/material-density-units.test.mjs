import { describe, expect, test } from '@jest/globals';
import { normalizeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';
import { completeDeclaredGradeMaterials } from '../../../dist/agent-runtime/template-properties.js';

describe('explicit material density units at the draft boundary', () => {
  test.each([
    [25, 'kN/m3', 25000 / 9.80665], [24516.625, 'N/m3', 2500],
    [2.5, 't/m3', 2500], [2500, 'kg/m3', 2500],
  ])('converts %s %s without LLM arithmetic', (value, unit, expected) => {
    const source = { materials: [{ id: 'RC', grade: 'C35', density: { value, unit }, extra: { source: 'accepted scheme' } }] };
    const before = structuredClone(source);
    const result = normalizeEngineeringDraft(source).materials[0];
    expect(result.rho).toBeCloseTo(expected, 10);
    expect(result.extra).toEqual({ source: 'accepted scheme', densityInput: { value, unit } });
    expect(result).not.toHaveProperty('density');
    expect(completeDeclaredGradeMaterials([result])[0].rho).toBe(result.rho);
    expect(source).toEqual(before);
  });

  test('a unit-bearing correction preserves the other confirmed records and explicit properties', () => {
    const accepted = handler.mergeState(undefined, handler.extractDraft({ llmDraftPatch: { engineeringDraft: {
      materials: [{ id: 'RC', name: 'C35', E: 31500, nu: 0.2, rho: 2.55e-9 },
        { id: 'STEEL', name: 'Project steel', E: 206000, nu: 0.3, rho: 7900 }],
      geometry: { storyHeightsM: [4.5, 3.6, 3.6] },
      loads: [{ id: 'roof', kind: 'line', magnitude: 19.8, unit: 'kN/m', direction: 'gravity', target: 'x-beams', location: { story: 3 } }],
    } } }));
    const before = structuredClone(accepted);
    const patch = handler.extractDraft({ currentState: accepted, llmDraftPatch: { engineeringDraft: {
      materials: [{ id: 'RC', density: { value: 25, unit: 'kN/m3' } }],
    } } });
    const next = handler.mergeState(accepted, patch);
    expect(next.engineeringDraft.materials[0]).toMatchObject({ id: 'RC', E: 31500, nu: 0.2 });
    expect(next.engineeringDraft.materials[0].rho).toBeCloseTo(25000 / 9.80665, 10);
    expect(next.engineeringDraft.materials[1]).toEqual(before.engineeringDraft.materials[1]);
    expect(next.engineeringDraft.geometry).toEqual(before.engineeringDraft.geometry);
    expect(next.engineeringDraft.loads).toEqual(before.engineeringDraft.loads);
    expect(accepted).toEqual(before);
  });

  test.each([
    { value: 25 }, { value: 25, unit: 'unknown' }, { value: -25, unit: 'kN/m3' },
    { value: '25', unit: 'kN/m3' }, { value: Infinity, unit: 'kg/m3' },
  ])('rejects an invalid or missing declared unit without guessing (%j)', density => {
    expect(() => normalizeEngineeringDraft({ materials: [{ id: 'RC', density }] })).toThrow('MATERIAL_DENSITY_INVALID');
  });

  test('rejects conflicting representations and never guesses from a bare SI value', () => {
    expect(() => normalizeEngineeringDraft({ materials: [{ id: 'RC', rho: 2.55e-9,
      density: { value: 25, unit: 'kN/m3' } }] })).toThrow('MATERIAL_DENSITY_INVALID');
    expect(normalizeEngineeringDraft({ materials: [{ id: 'explicit', rho: 2.55e-9 }] }).materials[0].rho).toBe(2.55e-9);
  });
});
