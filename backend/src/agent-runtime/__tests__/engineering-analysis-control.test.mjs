import { describe, expect, test } from '@jest/globals';
import { normalizeEngineeringDraft, mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
import { buildModel } from '../../../dist/agent-runtime/model-builder.js';
import { buildFrameModel } from '../../../dist/agent-skills/structure-type/frame/model.js';
import { buildExplicitDraftModel } from '../../../dist/agent-runtime/explicit-model.js';
import { tryBuildGenericModelWithLlm } from '../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { normalizeEngineeringModel } from '../../../dist/engineering/model-boundary.js';
import { createLocalStructureProtocolClient } from '../../../dist/services/structure-protocol-execution.js';
import { buildConcreteFrameModel } from '../../../dist/agent-skills/structure-type/concrete-frame/model.js';
import { handler as concreteHandler } from '../../../dist/agent-skills/structure-type/concrete-frame/handler.js';

const beamState = control => ({ inferredType: 'beam', frameDimension: '2d', lengthM: 6, loadKN: 10,
  loadType: 'distributed', supportType: 'simply-supported', engineeringDraft: normalizeEngineeringDraft({
    material: { grade: 'Q235' }, sections: { member: 'H300X200X8X12' }, analysisControl: control,
  }) });
const normalize = model => normalizeEngineeringModel(model, createLocalStructureProtocolClient());
const concreteState = control => ({ inferredType: 'frame', structuralTypeKey: 'concrete-frame', skillId: 'concrete-frame',
  frameDimension: '2d', storyCount: 1, bayCount: 1, storyHeightsM: [3], bayWidthsM: [6],
  floorLoads: [{ story: 1, verticalKN: 20 }], frameConcreteGrade: 'C30', frameRebarGrade: 'HRB400',
  frameColumnSection: '500X500', frameBeamSection: '300X600',
  engineeringDraft: normalizeEngineeringDraft({ analysisControl: control }) });

describe('confirmed draft analysis controls reach every V2 model-building path', () => {
  test('partial updates preserve false and unrelated nested controls without mutating source evidence', () => {
    const input = { analysisControl: { self_weight: true, rigid_floor: false, self_weight_case_id: 'D',
      design_params: { pkpm: { optionA: 1, optionB: false } } } };
    const first = normalizeEngineeringDraft(input);
    const next = mergeEngineeringDraft(first, normalizeEngineeringDraft({ analysisControl: {
      self_weight: false, design_params: { pkpm: { optionA: 2 } },
    } }));
    expect(next.analysisControl).toEqual({ self_weight: false, rigid_floor: false, self_weight_case_id: 'D',
      design_params: { pkpm: { optionA: 2, optionB: false } } });
    expect(first.analysisControl).toEqual(input.analysisControl);
    expect(first.analysisControl).not.toBe(input.analysisControl);
    expect(() => normalizeEngineeringDraft({ analysisControl: [] })).toThrow('INVALID_ANALYSIS_CONTROL');
  });

  test.each([true, false])('beam and frame templates preserve explicit self_weight=%s through real V2 normalization', async selfWeight => {
    const control = { self_weight: selfWeight, self_weight_case_id: 'LC1', gravity_m_s2: 9.81, rigid_floor: false };
    const beam = buildModel(beamState(control));
    const frame = buildFrameModel({ ...beamState(control), inferredType: 'frame', frameDimension: '2d', storyCount: 1,
      bayCount: 1, storyHeightsM: [3], bayWidthsM: [6], floorLoads: [{ story: 1, verticalKN: 20 }] });
    expect(beam.analysis_control).toEqual(control);
    expect(frame.analysis_control).toEqual(control);
    expect((await normalize(beam)).analysis_control).toMatchObject(control);
    expect((await normalize(frame)).analysis_control).toMatchObject(control);
  }, 30000);

  test('explicit topology receives controls; a full imported model keeps its own controls and rejects conflicts', async () => {
    const source = buildModel(beamState({ self_weight: true, self_weight_case_id: 'LC1', rigid_floor: false }));
    const topology = buildExplicitDraftModel({ frameDimension: '2d', engineeringDraft: normalizeEngineeringDraft({
      topology: { nodes: source.nodes, members: source.elements }, materials: source.materials,
      sectionRecords: source.sections, loadCases: source.load_cases, analysisControl: source.analysis_control,
    }) });
    expect((await normalize(topology)).analysis_control).toMatchObject(source.analysis_control);
    const imported = buildExplicitDraftModel({ engineeringDraft: { model: source } });
    expect(imported.analysis_control).toEqual(source.analysis_control);
    const previouslyUnset = buildExplicitDraftModel({ engineeringDraft: { model: { ...source, analysis_control: null },
      analysisControl: { self_weight: false } } });
    expect(previouslyUnset.analysis_control).toEqual({ self_weight: false });
    expect(() => buildExplicitDraftModel({ engineeringDraft: { model: source, analysisControl: { self_weight: false } } }))
      .toThrow('ANALYSIS_CONTROL_CONFLICT: analysis_control.self_weight');
    expect(source.analysis_control.self_weight).toBe(true);
  }, 30000);

  test.each([true, false])('the concrete-frame handler preserves self_weight=%s without replacing its other controls', async selfWeight => {
    const state = { ...concreteState({ self_weight: selfWeight, rigid_floor: false }), analysisControl: { modalCount: 6 } };
    const model = concreteHandler.buildModel(state);
    expect(model.analysis_control).toMatchObject({ self_weight: selfWeight, rigid_floor: false, modal_count: 6 });
    expect((await normalize(model)).analysis_control).toMatchObject({ self_weight: selfWeight, rigid_floor: false, modal_count: 6 });
  }, 30000);

  test('concrete-frame source controls cannot silently contradict an explicitly provided legacy control', () => {
    const state = { ...concreteState({ rigid_floor: false }), analysisControl: { rigidFloor: true } };
    expect(() => buildConcreteFrameModel(state)).toThrow('ANALYSIS_CONTROL_CONFLICT: analysis_control.rigid_floor');
  });

  test.each([true, false])('generic generation projects confirmed self_weight=%s even when the generated candidate disagrees', async selfWeight => {
    const state = beamState({ self_weight: selfWeight, rigid_floor: false });
    const candidate = buildModel(beamState({ self_weight: !selfWeight }));
    let seenPrompt = '';
    const result = await tryBuildGenericModelWithLlm({ invoke: async prompt => {
      seenPrompt = prompt; return { content: JSON.stringify(candidate) };
    } }, 'Use the confirmed beam data', state, 'en');
    expect(seenPrompt).toContain(`"self_weight":${selfWeight}`);
    expect(result.analysis_control).toMatchObject({ self_weight: selfWeight, rigid_floor: false });
    expect((await normalize(result)).analysis_control).toMatchObject({ self_weight: selfWeight, rigid_floor: false });
  }, 30000);
});


describe('generic topology uses confirmed section geometry without invented rounded properties', () => {
  test('real normalization derives exact stiffness from the confirmed rectangle even if the LLM duplicates rounded values', async () => {
    const state = beamState({ self_weight: false });
    state.engineeringDraft.sectionRecords = [{ id: 'user-section', name: '100 by 200 mm', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 } }];
    const candidate = buildModel(beamState({ self_weight: false }));
    candidate.sections = [{ id: '1', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 },
      properties: { A: .02, Iy: .000066667, Iz: .000016667 } }];
    const before = structuredClone(state);
    const result = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) },
      'Use the confirmed 100 mm wide, 200 mm high rectangle', state, 'en');
    const model = await normalize(result);
    expect(model.sections[0].properties.Iy).toBeCloseTo(100 * 200 ** 3 / 12e12, 14);
    expect(model.sections[0].properties.Iz).toBeCloseTo(200 * 100 ** 3 / 12e12, 14);
    expect(model.sections[0].extra.derived_properties.method).toBe('section-geometry-v1');
    expect(model.elements[0].section).toBe(model.sections[0].id);
    expect(state).toEqual(before);
  }, 30000);

  test('conflicting properties explicitly present in the confirmed source are retained and rejected, not silently corrected', async () => {
    const state = beamState({ self_weight: false });
    state.engineeringDraft.sectionRecords = [{ id: '1', type: 'rectangular', shape: { kind: 'rectangular', B: 100, H: 200 }, properties: { Iy: .0001 } }];
    const candidate = buildModel(beamState({ self_weight: false }));
    const result = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Use the supplied record', state, 'en');
    expect(result.sections[0].properties.Iy).toBe(.0001);
    await expect(normalize(result)).rejects.toThrow(/conflicts with geometry/);
  }, 30000);
});
