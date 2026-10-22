import { expect, test } from '@jest/globals';
import { frameNodalLoads } from '../../../../dist/skill-shared/modelling/frame-loads.js';
import { projectDraftPatch } from '../../../../dist/agent-runtime/draft/project-patch.js';
import { handler as beamHandler } from '../../../../dist/agent-skills/structure-type/beam/handler.js';
import { handler as columnHandler } from '../../../../dist/agent-skills/structure-type/column/handler.js';
import { computeDraftMissing } from '../../../../dist/agent-runtime/draft-readiness.js';

const nodes = [0, 3].flatMap(z => [0, 5, 10].map((x, index) => ({ id: `N${z}_${index}`, x, y: 0, z })));
const nodal = nodeRole => ({ kind: 'nodal', magnitude: 1, unit: 'kN', direction: 'globalX', location: { story: 1, nodeRole } });
const project = loads => projectDraftPatch({ engineeringDraft: { geometry: { storyHeightsM: [3, 3, 3], bayWidthsM: [5] }, loads } }, 'frame');
const floor = (target, location) => ({ kind: 'point', magnitude: 2, unit: 'kN', direction: 'globalX', ...(target === undefined ? {} : { target }), ...(location ? { location } : {}) });

test.each(['not-right', '左侧不是右侧', 'not-middle', 'right or left', 'rightmost except end'])
('a prose nodeRole cannot select a grid node: %s', nodeRole => {
  expect(() => frameNodalLoads([nodal(nodeRole)], nodes)).toThrow('FRAME_NODAL_TARGET_UNRESOLVED');
});
test.each([['right-side', 'N3_2'], ['left', 'N3_0'], ['center', 'N3_1'], ['corner-x2y0', 'N3_2']])
('canonical role %s resolves its explicit node', (role, node) => {
  expect(frameNodalLoads([nodal(role)], nodes)).toMatchObject([{ record: { node, fx: 1 } }]);
});
test.each(['不是第三层', 'not roof', '非屋顶', 'not floor 2', '第十一层', '柱顶', undefined])
('a floor target requires a typed selector instead of prose: %s', target => {
  expect(() => project([floor(target)])).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('untargeted load order never assigns floors or discards excess loads', () => {
  expect(() => project([floor(), floor(), floor(), floor()])).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('structured story selection and exact legacy IDs remain supported', () => {
  expect(project([floor('floor', { story: 2 }), floor('floor 1'), floor('roof')]).floorLoads)
    .toEqual([{ story: 1, lateralXKN: 2 }, { story: 2, lateralXKN: 2 }, { story: 3, lateralXKN: 2 }]);
});
test('all-stories is an explicit selector, not an omitted-target default', () => {
  expect(project([floor('all-stories')]).floorLoads).toEqual([1, 2, 3].map(story => ({ story, lateralXKN: 2 })));
});
test('invalid structured story is not replaced by the roof alias', () => {
  expect(() => project([floor('roof', { story: 99 })])).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test.each(['not-roof', '非夹层而是屋顶', 'roof or mezzanine', undefined])
('portal loads require an explicit canonical target: %s', target => {
  expect(() => projectDraftPatch({ engineeringDraft: { loads: [{ kind: 'line', magnitude: 2, unit: 'kN/m', direction: 'gravity', target }] } }, 'portal-frame'))
    .toThrow('MODEL_EDIT_FIELD_INVALID');
});
test('beam point loads without a supplied position do not acquire midspan', () => {
  const patch = projectDraftPatch({ engineeringDraft: { loads: [floor('beam')] } }, 'beam');
  expect(patch.loadPosition).toBeUndefined();
  expect(patch.engineeringDraft.loads[0]).not.toHaveProperty('location');
  expect(patch.draftIssues).toContainEqual(expect.objectContaining({ field: 'loads[0].location.xM', kind: 'missing' }));
});
test('column point loads without a target retain a blocking diagnostic rather than moving to the top', () => {
  const patch = projectDraftPatch({ engineeringDraft: { loads: [floor()] } }, 'column');
  expect(patch.engineeringDraft.loads).toEqual([floor()]);
  expect(patch.skillState).not.toHaveProperty('columnLoads');
  expect(patch.draftIssues).toContainEqual(expect.objectContaining({ field: 'loads[0].target', kind: 'missing' }));
});

test('an unnamed column load without a target remains critical through the real handler merge', () => {
  const raw = { engineeringDraft: { geometry: { heightM: 3 },
    material: { family: 'concrete', grade: 'C30' }, sections: { column: '300X500' }, loads: [floor()] } };
  const state = columnHandler.mergeState(undefined, columnHandler.extractDraft({ llmDraftPatch: raw }));
  expect(state.engineeringDraft.loads[0]).not.toHaveProperty('target');
  expect(computeDraftMissing({ id: 'column', handler: columnHandler }, state, 'execution').critical)
    .toContain('loads[0].target');
  expect(columnHandler.buildModel(state)).toBeUndefined();
});

test('an unnamed beam load without a location cannot be resolved by an old flat position', () => {
  const before = { inferredType: 'beam', updatedAt: 1, lengthM: 10, loadKN: 1,
    loadType: 'point', loadPosition: 'end', supportType: 'simply-supported',
    engineeringDraft: { geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
      material: { family: 'steel', grade: 'Q235' }, sections: { beam: '300X500' } } };
  const snapshot = structuredClone(before);
  const patch = beamHandler.extractDraft({ currentState: before, llmDraftPatch: { engineeringDraft: { loads: [floor('beam')] } } });
  const after = beamHandler.mergeState(before, patch);
  expect(after.engineeringDraft.loads[0]).not.toHaveProperty('location');
  expect(computeDraftMissing({ id: 'beam', handler: beamHandler }, after, 'execution').critical)
    .toContain('loads[0].location.xM');
  expect(beamHandler.buildModel(after)).toBeUndefined();
  expect(before).toEqual(snapshot);
});
test.each(['not column-top', '不是柱顶', 'base', 'column'])('column target %s is not silently moved to the top', target => {
  expect(() => projectDraftPatch({ engineeringDraft: { loads: [floor(target)] } }, 'column')).toThrow('MODEL_EDIT_FIELD_INVALID');
});
test.each([['300X500', .3, .5], ['0.3X0.5m', .3, .5], ['0.3X0.5', .0003, .0005]])
('column rectangle dimensions follow the explicit unit or the mm contract (%s)', (section, width, depth) => {
  expect(projectDraftPatch({ engineeringDraft: { sections: { column: section } } }, 'column').skillState)
    .toMatchObject({ sectionWidthM: width, sectionDepthM: depth });
});
test.each(['not 300X500', '300X500 or 400X600', 'H300X200X8X12'])
('arbitrary section prose is not projected into rectangle dimensions (%s)', section => {
  expect(projectDraftPatch({ engineeringDraft: { sections: { column: section } } }, 'column').skillState)
    .not.toHaveProperty('sectionWidthM');
});

test('a new point load without a location stays critical even when an old load position exists', () => {
  const before = beamHandler.mergeState(undefined, beamHandler.extractDraft({ llmDraftPatch: { engineeringDraft: {
    geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
    material: { family: 'steel', grade: 'Q235' }, sections: { beam: '300X500' },
    loads: [{ id: 'P1', ...floor('beam', { xM: 10 }) }],
  } } }));
  const snapshot = structuredClone(before);
  const patch = beamHandler.extractDraft({ currentState: before, llmDraftPatch: {
    engineeringDraft: { loads: [{ id: 'P2', ...floor('beam') }] },
  } });
  const after = beamHandler.mergeState(before, patch);
  expect(after.engineeringDraft.loads).toHaveLength(2);
  expect(after.engineeringDraft.loads[1]).not.toHaveProperty('location');
  expect(computeDraftMissing({ id: 'beam', handler: beamHandler }, after, 'execution').critical)
    .toContain('loads["P2"].location.xM');
  expect(before).toEqual(snapshot);
});

test('an unresolved replacement section is retained and cannot use old rectangle dimensions', () => {
  const before = columnHandler.mergeState(undefined, columnHandler.extractDraft({ llmDraftPatch: { engineeringDraft: {
    geometry: { heightM: 3 }, material: { family: 'concrete', grade: 'C30' }, sections: { column: '300X500' },
    loads: [{ id: 'P', ...floor('column-top') }],
  } } }));
  const snapshot = structuredClone(before);
  const patch = columnHandler.extractDraft({ currentState: before, llmDraftPatch: {
    engineeringDraft: { sections: { column: 'not 300X500' } },
  } });
  const after = columnHandler.mergeState(before, patch);
  expect(after.engineeringDraft.sections.column).toBe('not 300X500');
  expect(computeDraftMissing({ id: 'column', handler: columnHandler }, after, 'execution').critical)
    .toContain('templateProperties');
  expect(() => columnHandler.buildModel(after)).toThrow('TEMPLATE_PROPERTY_REQUIRED');
  expect(before).toEqual(snapshot);
});
