import { describe, expect, test } from '@jest/globals';
import { buildModel } from '../dist/agent-runtime/model-builder.js';
import { buildFrameModel } from '../dist/agent-skills/structure-type/frame/model.js';
import { reviewedSectionName } from '../dist/agent-runtime/section-catalog.js';
import { normalizeEngineeringModel } from '../dist/engineering/model-boundary.js';
import { applyModelEdits } from '../dist/engineering/model-state.js';
import { createLocalStructureProtocolClient } from '../dist/services/structure-protocol-execution.js';
import { tryBuildGenericModelWithLlm } from '../dist/agent-skills/structure-type/generic/llm-model-builder.js';

const supplement = { S: .000104, Wnx: .000237, b: .0465, t: .0114 };
const state = (name = 'GB/T 706 热轧工字钢 I20a') => ({ inferredType: 'beam', frameDimension: '2d',
  lengthM: 10, loadKN: 1, loadType: 'point', supportType: 'simply-supported', updatedAt: 0,
  engineeringDraft: { material: { grade: 'Q235B' }, sections: { beam: 'I20a' },
    analysisControl: { self_weight: false }, sectionRecords: [{ id: 'SECTION-USER', name, type: 'custom',
      properties: { ...supplement }, extra: { note: 'User supplied only supplemental design properties' } }] } });
const normalize = model => normalizeEngineeringModel(model, createLocalStructureProtocolClient());
const edit = (model, values) => applyModelEdits(model, [{ collection: 'sections', id: model.sections[0].id, operation: 'update', values }]);
const checkCatalog = section => {
  // Independent reviewed row: cm2 -> m2, cm4 -> m4, cm3 -> m3.
  expect(section.properties).toMatchObject({ A: .003555, Iy: .0000237, Iz: .00000158,
    Wx: .000237, Wz: .0000315, imin: .0212, tw: .007, ...supplement });
  expect(section.extra.catalogSource).toMatchObject({ recordId: 'I20a', status: 'reference-data-from-public-draft',
    axisMapping: 'table Ix -> model Iy; table Iy -> model Iz',
    sha256: '1aff5bea9e9c9fdb27c09aa2de9000b00f8760af0ad733f1f994017c7838b5a5' });
  expect(section.extra.catalogDimensionsMM).toEqual({ H: 200, B: 100, tw: 7, tf: 11.4, r1: 9, r2: 4.5 });
  expect(section.shape).toBeUndefined(); expect(section.properties.J).toBeUndefined();
};

describe('reviewed catalog identity and supplementary records', () => {
  test.each(['I20a', 'Ⅰ20a', 'GB/T 706 热轧工字钢 I20a', 'GB/T 706-2016 I20a'])('recognizes explicit reviewed identity %s', name => {
    expect(reviewedSectionName(name)).toBe('I20a');
  });
  test.each(['I20ab', 'custom20a', 'customI20a', 'GB/T 706 I20ab', 'GB/T 7060 I20a', 'I20a modified custom'])('does not guess an identity for %s', name => {
    expect(reviewedSectionName(name)).toBeUndefined();
  });
  test.each(['GB/T 706 热轧工字钢 I20a', 'user beam section'])('template supplements %s without losing values, ID or notes', async name => {
    const input = state(name), before = structuredClone(input);
    const model = await normalize(buildModel(input));
    checkCatalog(model.sections[0]);
    expect(model.sections[0]).toMatchObject({ id: 'SECTION-USER', name, extra: { note: input.engineeringDraft.sectionRecords[0].extra.note } });
    expect(model.elements.every(element => element.section === 'SECTION-USER')).toBe(true);
    expect(input).toEqual(before);
  }, 30000);
  test.each([null, {}])('empty geometry placeholders %j cannot overwrite catalog geometry and directional shear supplements are preserved', async placeholder => {
    const input = state();
    Object.assign(input.engineeringDraft.sectionRecords[0], { width: null, height: null, shape: placeholder, dimensions: placeholder });
    input.engineeringDraft.sectionRecords[0].properties.Asy = .001;
    const model = await normalize(buildModel(input));
    checkCatalog(model.sections[0]);
    expect(model.sections[0]).toMatchObject({ width: 100, height: 200, properties: { Asy: .001 } });
  }, 30000);
  test('a multi-role frame uses stable assignments to hydrate only the declared catalog section', () => {
    const input = state('beam label');
    Object.assign(input, { inferredType: 'frame', storyCount: 1, bayCount: 1, storyHeightsM: [3], bayWidthsM: [6], floorLoads: [{ story: 1, verticalKN: 10 }] });
    input.engineeringDraft.sectionRecords.push({ id: 'CUSTOM-COLUMN', name: 'custom column', type: 'custom', properties: { A: .02, Iy: .0001, Iz: .0002, J: .00005 } });
    input.engineeringDraft.templateAssignments = { beam: { materialId: '1', sectionId: 'SECTION-USER' }, column: { materialId: '1', sectionId: 'CUSTOM-COLUMN' } };
    const model = buildFrameModel(input);
    checkCatalog(model.sections.find(section => section.id === 'SECTION-USER'));
    expect(model.sections.find(section => section.id === 'CUSTOM-COLUMN').properties).toEqual(input.engineeringDraft.sectionRecords[1].properties);
  });
  test('explicit basic properties under the same name remain a custom numerical source', async () => {
    const input = state('I20a');
    Object.assign(input.engineeringDraft.sectionRecords[0].properties, { A: .004, Iy: .00003, Iz: .000002 });
    const model = await normalize(buildModel(input));
    expect(model.sections[0].properties).toEqual(input.engineeringDraft.sectionRecords[0].properties);
    expect(model.sections[0].extra.catalogSource).toBeUndefined();
  }, 30000);
});

describe('catalog source claims survive only consistent model conversion and edits', () => {
  test.each(['A', 'Iy', 'Iz', 'Wx', 'Wz', 'tw', 'imin'])('a retained source rejects changed properties.%s without modifying the accepted model', async property => {
    const model = buildModel(state()), before = structuredClone(model);
    const candidate = edit(model, { properties: { [property]: model.sections[0].properties[property] * 1.5 } });
    await expect(normalize(candidate)).rejects.toThrow(`CATALOG_SECTION_CONFLICT: sections.SECTION-USER.properties.${property}`);
    expect(model).toEqual(before);
  });
  test('only supplemental edits are accepted and retain the reviewed elastic values', async () => {
    const model = buildModel(state());
    const result = await normalize(edit(model, { properties: { S: .000105, Wnx: .00022, b: .045, t: .011 } }));
    expect(result.sections[0].properties).toMatchObject({ A: .003555, Iy: .0000237, Iz: .00000158,
      S: .000105, Wnx: .00022, b: .045, t: .011 });
    expect(result.sections[0].extra).toEqual(model.sections[0].extra);
  }, 30000);
  test.each([
    { width: 120 }, { shape: { kind: 'H', B: 100, H: 200, tw: 7, tf: 11.4 } },
    { extra: { catalogDimensionsMM: { tf: 12 } } }, { extra: { catalogSource: { axisMapping: 'swapped axes' } } },
    { extra: { catalogSource: null } }, { extra: { catalogSource: null, catalogDimensionsMM: null } },
    { extra: { catalogSource: null, catalogDimensionsMM: null, customSectionBasis: ' ' } },
  ])('inconsistent geometry, source claims and incomplete custom releases are rejected (%j)', async values => {
    await expect(normalize(edit(buildModel(state()), values))).rejects.toThrow('CATALOG_SECTION_CONFLICT');
  });
  test('an unregistered external provenance claim is explicitly unverified, not silently treated as this reviewed catalog', async () => {
    const model = buildModel(state());
    model.sections[0].extra.catalogSource = { vendor: 'external table', row: 'I20a' };
    await expect(normalize(model)).rejects.toThrow('CATALOG_SECTION_SOURCE_UNVERIFIED');
  });
  test('explicitly releasing both catalog claims with a custom basis permits genuinely custom numbers under the same name', async () => {
    const model = buildModel(state());
    const result = await normalize(edit(model, { properties: { A: .004, Iy: .00003, Iz: .000002 },
      extra: { catalogSource: null, catalogDimensionsMM: null, customSectionBasis: 'User supplied project-specific numerical section from attachment' } }));
    expect(result.sections[0].name).toBe(model.sections[0].name);
    expect(result.sections[0].properties).toMatchObject({ A: .004, Iy: .00003, Iz: .000002 });
    expect(result.sections[0].extra.catalogSource).toBeNull();
    expect(model.sections[0].extra.catalogSource.recordId).toBe('I20a');
  }, 30000);
});

describe('generic builder projects the same confirmed catalog and numeric sources', () => {
  test('LLM topology with different section ID cannot replace a confirmed supplemented catalog with invented inertia', async () => {
    const input = state(), before = structuredClone(input);
    const candidate = buildModel(state());
    candidate.sections = [{ id: 'GENERATED-S', name: 'generated I20a', type: 'custom', properties: { A: .0035578, Iy: .0000158, Iz: .0000237 } }];
    candidate.elements.forEach(element => { element.section = 'GENERATED-S'; });
    const output = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) },
      'Use the confirmed I20a and supplemental design properties', input, 'en');
    const model = await normalize(output);
    checkCatalog(model.sections[0]);
    expect(model.sections[0].id).toBe('GENERATED-S');
    expect(model.elements.every(element => element.section === 'GENERATED-S')).toBe(true);
    expect(input).toEqual(before);
  }, 30000);
  test('a single confirmed catalog role also supplies the generic builder without hand-authored section records', async () => {
    const input = state();
    delete input.engineeringDraft.sectionRecords;
    const candidate = buildModel(state());
    candidate.sections[0] = { id: 'SECTION-USER', name: 'generated section', type: 'custom', properties: { A: 9, Iy: 8, Iz: 7 } };
    const output = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Use the confirmed I20a', input, 'en');
    const model = await normalize(output);
    expect(model.sections[0].properties).toMatchObject({ A: .003555, Iy: .0000237, Iz: .00000158 });
    expect(model.sections[0].properties.S).toBeUndefined();
    expect(model.sections[0].extra.catalogSource.recordId).toBe('I20a');
  }, 30000);
  test('explicit custom core numbers and unknown incomplete sources are preserved rather than catalog-filled or invented', async () => {
    for (const properties of [{ ...supplement, A: .004, Iy: .00003, Iz: .000002 }, { S: .000104 }]) {
      const input = state('unreviewed section');
      delete input.engineeringDraft.sections;
      input.engineeringDraft.sectionRecords[0].properties = properties;
      const candidate = buildModel(state());
      const output = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Use my explicit record', input, 'en');
      expect(output.sections[0].properties).toEqual(properties);
      expect(output.sections[0].extra.catalogSource).toBeUndefined();
    }
  }, 30000);
});
