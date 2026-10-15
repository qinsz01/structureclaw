import { expect, test, jest } from '@jest/globals';
const extract = jest.fn();
jest.unstable_mockModule('../../../dist/agent-langgraph/param-extractor.js', () => ({ invokeParamExtractor: extract }));
const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
const { createExtractDraftParamsTool } = await import('../../../dist/agent-langgraph/tools.js');
const { createLocalStructureProtocolClient } = await import('../../../dist/services/structure-protocol-execution.js');
const { engineeringModelSchema, draftSectionShapeSchema, normalizeDraftSectionInputs, normalizeModelEdits } = await import('../../../dist/engineering/model-edit-contract.js');
const { normalizeEngineeringModel } = await import('../../../dist/engineering/model-boundary.js');
const { mergeEngineeringDraft } = await import('../../../dist/agent-runtime/engineering-draft.js');
const client = createLocalStructureProtocolClient();
const contract = await engineeringModelSchema(client);
const shapeSchema = draftSectionShapeSchema(contract);
const plugin = { id: 'beam', structureType: 'beam', manifest: { structuralTypeKeys: ['beam'] }, handler };
const tool = createExtractDraftParamsTool({ resolvePluginForType: async () => plugin });
const requestScope = { responses: ['forces', 'displacements'], method: 'solver', design: true, report: false, outputs: [] };
const source = { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
  material: { family: 'steel', grade: 'Q235B' }, sections: { beam: 'HW300×300×10×15' },
  sectionRecords: [{ id: 'SEC-BEAM-1', name: 'HW300×300×10×15', type: 'h', shape: { kind: 'h', H: 300, B: 300, tw: 10, tf: 15 } }],
  loads: [{ kind: 'point', magnitude: 1, unit: 'kN', target: 'beam', location: { xM: 5 } }] };
const invoke = state => tool.invoke({ locale: 'zh', message: '钢结构：Q235B 钢材，截面采用 HW300×300×10×15 热轧H型钢', requestScope },
  { toolCall: { id: 'h-section-extract' }, configurable: { structureProtocolClient: client, agentState: state } });

test('the reported H draft is canonical before canProceed and reaches the formal model unchanged physically', async () => {
  extract.mockResolvedValue({ engineeringDraft: structuredClone(source) });
  const result = await invoke({ structuralTypeKey: 'beam' });
  const draft = result.update.draftState;
  const feedback = JSON.parse(result.update.messages[0].content);
  expect(feedback.canProceed).toBe(true);
  expect(draft.engineeringDraft.sectionRecords[0]).toEqual({ ...source.sectionRecords[0], type: 'H', shape: { ...source.sectionRecords[0].shape, kind: 'H' } });
  expect(draft.skillState.engineeringDraft).toEqual(draft.engineeringDraft);
  expect(extract.mock.lastCall[0].sectionShapeSchema).toEqual(shapeSchema);
  const model = await normalizeEngineeringModel(handler.buildModel(draft), client);
  expect(model.sections[0]).toMatchObject({ id: 'SEC-BEAM-1', shape: { kind: 'H', H: 300, B: 300, tw: 10, tf: 15 } });
  expect(model.sections[0].properties.Iy).toBeCloseTo((.3*.3**3 - .29*.27**3)/12, 13);
  expect(source.sectionRecords[0].shape.kind).toBe('h');
});

test('all declared kinds have the same canonical spelling in extraction, editing and the Python schema', () => {
  for (const kind of shapeSchema.properties.kind.enum) {
    for (const spelling of [kind.toLowerCase(), kind.toUpperCase(), ` ${kind.toLowerCase()} `]) {
      const draft = { sectionRecords: [{ id: 'S', type: spelling, shape: { kind: spelling } }] };
      expect(normalizeDraftSectionInputs(draft, contract).sectionRecords[0]).toEqual({ id: 'S', type: kind, shape: { kind } });
      const edits = normalizeModelEdits({}, [{ operation: 'update', collection: 'sections', id: 'S', values: { 'shape.kind': spelling } }], contract);
      expect(edits[0].values).toEqual({ shape: { kind } });
      expect(draft.sectionRecords[0].shape.kind).toBe(spelling);
    }
  }
});

test.each([{ kind: 'hexagonal' }, { kind: 'H', height: 300 }, { kind: 'H', tw: -1 }, { kind: 'H', H: Infinity }])('invalid shape %j fails extraction atomically', async shape => {
  const state = { structuralTypeKey: 'beam', draftState: handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: source } })) };
  const before = structuredClone(state);
  extract.mockResolvedValue({ engineeringDraft: { sectionRecords: [{ id: 'SEC-BEAM-1', shape }] } });
  await expect(invoke(state)).rejects.toThrow('MODEL_EDIT_FIELD_INVALID');
  expect(state).toEqual(before);
});

test('case-only clarification and reload preserve confirmed properties, IDs and evidence', async () => {
  const before = structuredClone(source);
  before.sectionRecords[0].properties = { J: .000001, S: .0002 };
  before.sectionRecords[0].extra = { source: 'user supplied torsion and statical moment' };
  const merged = mergeEngineeringDraft(before, { sectionRecords: [{ id: 'SEC-BEAM-1', shape: { kind: 'H' } }] });
  const canonical = normalizeDraftSectionInputs(merged, contract);
  expect(canonical.sectionRecords[0]).toEqual({ ...before.sectionRecords[0], type: 'H', shape: { ...before.sectionRecords[0].shape, kind: 'H' } });
  // Old persisted lowercase drafts also work without re-extraction or history mutation.
  const old = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: before } }));
  const model = await normalizeEngineeringModel(handler.buildModel(old), client);
  expect(model.sections[0].properties).toMatchObject({ J: .000001, S: .0002 });
  expect(old.engineeringDraft.sectionRecords[0].shape.kind).toBe('h');
});

test.each(['H300X300X10X15', 'HW300×300×10×15', 'HN400×200×8×13', 'HM300x200x8x12'])('four explicit dimensions in %s do not require a catalog lookup', async name => {
  const state = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: {
    ...source, sectionRecords: [], sections: { beam: name }, analysisControl: { self_weight: false },
  } } }));
  const model = await normalizeEngineeringModel(handler.buildModel(state), client);
  expect(model.sections[0].shape.kind).toBe('H');
  expect(model.sections[0].properties.Iy).toBeGreaterThan(0);
  expect(model.sections[0].standard_steel_name).toBeUndefined();
});

test.each(['HW300×300', 'HN400×200', 'HW300×300×10×200'])('incomplete or impossible designation %s is not guessed', name => {
  const state = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: { ...source, sectionRecords: [], sections: { beam: name } } } }));
  expect(() => handler.buildModel(state)).toThrow();
});
