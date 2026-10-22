import { withDeclaredProperties } from '../../../../../tests/fixtures/declared-template-properties.mjs';
import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../../../dist/agent-skills/structure-type/column/handler.js';

describe('column handler', () => {

  test.each([
    [undefined, undefined, ['loadType', 'loadPosition']],
    ['point', undefined, ['loadPosition']],
    [undefined, 'top-nodes', ['loadType']],
  ])('legacy column load fields %s/%s cannot acquire a type or top location', (loadType, loadPosition, missingFields) => {
    const raw = { heightM: 3, loadKN: 10, loadType, loadPosition };
    const snapshot = structuredClone(raw);
    const patch = handler.extractDraft({ llmDraftPatch: raw });
    const state = handler.mergeState(undefined, patch);
    for (const field of missingFields) {
      expect(patch[field]).toBeUndefined();
      expect(state[field]).toBeUndefined();
      expect(handler.computeMissing(state, 'interactive').critical).toContain(field);
      expect(handler.computeMissing(state, 'execution').critical).toContain(field);
    }
    expect(raw).toEqual(snapshot);
  });

  test('explicit legacy top-point loads remain executable and magnitude-only edits preserve their location', () => {
    const before = handler.mergeState(undefined, handler.extractDraft({
      llmDraftPatch: { heightM: 3, loadKN: 10, loadType: 'point', loadPosition: 'top-nodes' },
    }));
    const after = handler.mergeState(before, handler.extractDraft({ currentState: before, llmDraftPatch: { loadKN: 20 } }));
    expect(after).toMatchObject({ loadKN: 20, loadType: 'point', loadPosition: 'top-nodes' });
    expect(handler.computeMissing(after, 'execution').critical).toEqual([]);
    expect(handler.buildModel(withDeclaredProperties(after)).load_cases[0].loads)
      .toContainEqual(expect.objectContaining({ node: '2', fz: -20 }));
    expect(before.loadKN).toBe(10);
  });

  test('an explicit legacy distributed load is not converted into a column-top point load', () => {
    const state = handler.mergeState(undefined, handler.extractDraft({
      llmDraftPatch: { heightM: 3, loadKN: 10, loadType: 'distributed', loadPosition: 'top-nodes' },
    }));
    expect(state.loadType).toBe('distributed');
    expect(handler.computeMissing(state, 'execution').critical).toContain('loadType');
    expect(() => handler.buildModel(withDeclaredProperties(state))).toThrow('MODEL_EDIT_FIELD_INVALID');
  });

  test('preserves semantic draft issues for column clarification', () => {
    const patch = handler.extractDraft({
      message: '',
      locale: 'en',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'column',
        },
        draftIssues: [{
          field: 'heightM',
          severity: 'invalid',
          reason: 'Column height must be positive.',
        }],
        skillState: { invalidDraftFields: ['heightM'] },
      },
    });

    expect(patch.draftIssues).toEqual([{
      field: 'heightM',
      severity: 'invalid',
      reason: 'Column height must be positive.',
    }]);
    expect(patch.skillState?.invalidDraftFields).toContain('heightM');
  });

  test('builds column model from engineeringDraft loads and section data', () => {
    const patch = handler.extractDraft({
      message: '',
      locale: 'zh',
      llmDraftPatch: {
        engineeringDraft: {
          structureType: 'column',
          geometry: { heightM: 4.2 },
          material: { family: 'concrete' },
          sections: { column: '450x450mm' },
          loads: [
            { kind: 'nodal', magnitude: 600, unit: 'kN', direction: 'gravity', target: 'top-node' },
            { kind: 'nodal', magnitude: 30, unit: 'kN', direction: 'globalX', target: 'top-node' },
          ],
        },
      },
    });
    const state = handler.mergeState(undefined, patch);
    const model = handler.buildModel(withDeclaredProperties(state));

    expect(handler.computeMissing(state, 'execution').critical).toEqual([]);
    expect(state.inferredType).toBe('column');
    expect(state.heightM).toBe(4.2);
    expect(state.loadKN).toBe(600);
    expect(state.skillState).toEqual(expect.objectContaining({
      materialFamily: 'concrete',
      sectionWidthM: 0.45,
      sectionDepthM: 0.45,
    }));
    expect(model.nodes).toHaveLength(2);
    expect(model.elements).toHaveLength(1);
    expect(model.load_cases[0].loads).toEqual([
      { node: '2', fz: -600, reference_frame: 'global' },
      { node: '2', fx: 30, reference_frame: 'global' },
    ]);
  });
});
