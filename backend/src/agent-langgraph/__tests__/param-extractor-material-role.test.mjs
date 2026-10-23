import { describe, expect, test } from '@jest/globals';
import { invokeParamExtractor } from '../../../dist/agent-langgraph/param-extractor.js';
import { draftContract } from '../../../dist/engineering/draft-contract.js';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';

const plugin = { id: 'generic', name: { en: 'Generic', zh: '通用' }, description: {},
  stages: ['draft'], structureType: 'unknown', markdownByStage: {} };

const readyDraft = () => ({
  structureType: 'frame', coordinateSystem: { dimension: '2d' },
  geometry: { bayWidthsM: [6, 7.5], storyHeightsM: [4.2, 3.6, 3.6] },
  materials: [{ id: 'M1', name: 'C30', family: 'concrete', grade: 'C30' }],
  sectionRecords: [{ id: 'S1', name: '500x500', type: 'rectangular',
    shape: { kind: 'rectangular', B: 500, H: 500 }, extra: { provenance: { shape: 'user' } } }],
  templateAssignments: { beam: { materialId: 'M1', sectionId: 'S1' }, column: { materialId: 'M1', sectionId: 'S1' } },
  boundary: { frameBaseSupportType: 'fixed' },
  loads: [{ id: 'DL', kind: 'line', magnitude: 27, unit: 'kN/m', direction: 'gravity', target: 'beam', location: { story: 1 } }],
  analysis: { engineTarget: 'pkpm' }, analysisControl: { self_weight: false },
});

describe('analysis material and reinforcement grade extraction contract', () => {
  test.each([['zh', true], ['en', true], ['zh', false], ['en', false]])(
    'the %s extraction prompt exposes the material role contract (patch=%s)', async (locale, patchMode) => {
      let prompt;
      await invokeParamExtractor({ locale, plugin, patchMode, message: 'Use the specified reinforcement grade for design.',
        existingState: { inferredType: 'frame', engineeringDraft: {} },
        llm: { invoke: async value => { prompt = value; return { content: '{}' }; } } });
      if (patchMode) expect(prompt).toContain(`material:{${Object.keys(draftContract.properties.material.properties).join(',')}}`);
      expect(prompt).toContain('Reinforcement grades used only for design belong in material.rebarGrade, not materials records.');
      expect(prompt).toContain('Explicitly modelled reinforcing members still require analysis material records and properties.');
      expect(prompt).toContain('仅用于设计验算的钢筋牌号写material.rebarGrade');
    },
  );

  test.each(['HRB400', 'project-reinforcement-grade'])('a structured design grade is preserved without demanding analysis constants (%s)', rebarGrade => {
    const accepted = handler.mergeState(undefined, handler.extractDraft({ llmDraftPatch: { engineeringDraft: readyDraft() } }));
    const before = structuredClone(accepted);
    const extracted = handler.extractDraft({ currentState: accepted,
      llmDraftPatch: { engineeringDraft: { material: { rebarGrade } } } });
    const next = handler.mergeState(accepted, extracted);
    expect(next.engineeringDraft.material.rebarGrade).toBe(rebarGrade);
    expect(next.engineeringDraft.materials).toEqual(before.engineeringDraft.materials);
    expect(next.engineeringDraft.templateAssignments).toEqual(before.engineeringDraft.templateAssignments);
    expect(handler.computeMissing(next).critical).toEqual([]);
    expect(accepted).toEqual(before);
  });

  test.each([false, true])('an explicitly declared incomplete analysis record is still reported (assigned=%s)', assigned => {
    const draft = readyDraft();
    draft.material = { rebarGrade: 'project-reinforcement-grade' };
    draft.materials.push({ id: 'M2', name: 'Project member material' });
    if (assigned) draft.templateAssignments.beam.materialId = 'M2';
    const state = handler.mergeState(undefined, handler.extractDraft({ llmDraftPatch: { engineeringDraft: draft } }));
    expect(handler.computeMissing(state).critical).toEqual(expect.arrayContaining([
      'materials.M2.E', 'materials.M2.nu', 'materials.M2.rho',
    ]));
    expect(state.engineeringDraft.materials.some(material => material.id === 'M2')).toBe(true);
  });
});
