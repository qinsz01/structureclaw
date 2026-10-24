import { describe, expect, test } from '@jest/globals';
import { expandModellingOperations } from '../../../dist/skill-shared/modelling/operations.js';
import { normalizeEngineeringDraft, mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
import { checkModelPhysics, appliedLoadTotals, compileConfirmedModelLoads } from '../../../dist/engineering/model-physics.js';
import { assertNoTerminalSemanticFailure } from '../../../dist/agent-langgraph/guards/terminal-failures.js';
import { resolveExtractionInputMessage, modellingConversationHistory } from '../../../dist/agent-langgraph/tools/input-message.js';
import { tryBuildGenericModelWithLlm } from '../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';

const grid = { id: 'g', op: 'regular-frame', dimension: '3d', bayWidthsX: [6, 6, 6, 6], bayWidthsY: [6, 6, 6],
  storeyHeights: [4.2, 3.6, 3.6], baseRestraint: 'fixed', material: 'M', columnSection: 'C', beamSection: 'B' };
const base = () => ({ schema_version: '2.2.0', unit_system: 'SI', materials: [{ id: 'M', E: 30000, nu: .2, rho: 2500 }],
  sections: [{ id: 'C', shape: { kind: 'rectangular', B: 600, H: 600 } }, { id: 'C3', shape: { kind: 'rectangular', B: 500, H: 500 } },
    { id: 'B', shape: { kind: 'rectangular', B: 300, H: 600 } }], analysis_control: { self_weight: false } });
const groups = () => [1, 2, 3].flatMap(story => {
  const rows = [];
  const add = (id, parallelTo, coordinate, magnitude, caseId) => rows.push({ id: `${id}${story}`, kind: 'line', magnitude,
    unit: 'kN/m', direction: 'gravity', caseId, selector: { type: 'beam', story: `g:F${story}`, parallelTo, coordinate } });
  for (const [y, suffix] of [[0, 'A'], [18, 'D']]) {
    add(`DL-${suffix}`, 'x', { axis: 'y', eq: y }, story === 3 ? 22.5 : 19.5, 'DL');
    add(`LL-${suffix}`, 'x', { axis: 'y', eq: y }, story === 3 ? 1.5 : 6, 'LL');
  }
  add('DL-inner', 'x', { axis: 'y', gt: 0, lt: 18 }, story === 3 ? 40.5 : 34.5, 'DL');
  add('LL-inner', 'x', { axis: 'y', gt: 0, lt: 18 }, story === 3 ? 3 : 12, 'LL');
  add('DL-Y', 'y', undefined, 4.5, 'DL');
  return rows;
});
const loadedFrame = () => expandModellingOperations({ ...base(), operations: [grid, ...groups().map(load => ({
  id: load.id, op: 'member-udl', selector: load.selector, caseId: load.caseId, vector: [0, 0, -load.magnitude] }))] });

describe('spatial selectors and independently checked load groups', () => {
  test('semantic group descriptions stay immutable while the LLM repairs its own geometry binding', async () => {
    const definition = base();
    const draft = normalizeEngineeringDraft({ geometry: { storyHeightsM: grid.storeyHeights, bayWidthsXM: grid.bayWidthsX, bayWidthsYM: grid.bayWidthsY },
      materials: definition.materials, sectionRecords: definition.sections, analysisControl: { self_weight: false },
      loads: [{ id: 'accepted-scope', kind: 'line', magnitude: 2, unit: 'kN/m', direction: 'gravity', caseId: 'DL',
        scopeDescription: 'Second-storey interior X beams, between Y=0 and Y=18m.', location: { story: 2 } }] });
    const before = structuredClone(draft), prompts = [];
    const model = await tryBuildGenericModelWithLlm({ invoke: async prompt => {
      prompts.push(prompt);
      return { content: JSON.stringify({ ...definition, load_cases: [{ id: 'DL', type: 'dead', loads: [] }],
        metadata: { compileDraftLoads: true, loadMappings: [{ loadId: 'accepted-scope', caseId: 'DL', selector: prompts.length === 1
          ? { type: 'beam', parallelTo: 'x', coordinate: { axis: 'z', lt: 0.1 } }
          : { type: 'beam', parallelTo: 'x', coordinate: { axis: 'y', gt: 0, lt: 18 } } }] }, operations: [grid] }) };
    } }, 'Use the accepted group without changing its load.', { inferredType: 'frame', engineeringDraft: draft }, 'en');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('LOAD_MAPPING_UNRESOLVED');
    expect(prompts[1]).toContain(draft.loads[0].scopeDescription);
    expect(appliedLoadTotals(model).DL).toEqual([0, 0, -96]);
    expect(draft).toEqual(before);
  });

  test('an atomic target-to-selector patch preserves storey scope and compiles only the confirmed floor', async () => {
    const before = normalizeEngineeringDraft({ geometry: { storyHeightsM: [4.2, 3.6, 3.6] }, loads: [
      { id: 'scope', kind: 'line', magnitude: 2, unit: 'kN/m', direction: 'gravity', caseId: 'DL', target: 'accepted-interior-beams', location: { story: 2 } },
    ] });
    const saved = structuredClone(before);
    const patch = normalizeEngineeringDraft({ loads: [{ id: 'scope', selector: { type: 'beam', parallelTo: 'x', coordinate: { axis: 'y', gt: 0, lt: 18 } } }] }, before);
    const draft = mergeEngineeringDraft(before, patch);
    expect(draft.loads[0].target).toBeUndefined();
    expect(draft.loads[0]).toMatchObject({ id: 'scope', magnitude: 2, caseId: 'DL', location: { story: 2 } });
    const model = await expandModellingOperations({ ...base(), load_cases: [{ id: 'DL', type: 'dead', loads: [] }], operations: [grid] });
    const compiled = compileConfirmedModelLoads(model, draft);
    expect(compiled.load_cases[0].loads).toHaveLength(8);
    expect(appliedLoadTotals(compiled).DL).toEqual([0, 0, -96]);
    expect(checkModelPhysics(compiled, draft).valid).toBe(true);
    expect(before).toEqual(saved);
    const inverse = mergeEngineeringDraft(draft, normalizeEngineeringDraft({ loads: [{ id: 'scope', target: 'USER-BEAM' }] }, draft));
    expect(inverse.loads[0].selector).toBeUndefined();
    expect(inverse.loads[0]).toMatchObject({ target: 'USER-BEAM', magnitude: 2, location: { story: 2 } });
  });

  test('scope changes never silently erase a confirmed load position', () => {
    const before = normalizeEngineeringDraft({ loads: [{ id: 'P', kind: 'point', magnitude: 10, unit: 'kN', target: 'beam', location: { xM: 3 } }] });
    const saved = structuredClone(before);
    expect(() => normalizeEngineeringDraft({ loads: [{ id: 'P', selector: { ids: ['N'] } }] }, before)).toThrow('LOAD_SELECTOR_CONFLICT');
    expect(before).toEqual(saved);
  });
  test('the confirmed third-storey columns are selected geometrically and assigned without changing lower storeys', async () => {
    const input = { ...base(), operations: [grid, { id: 'top', op: 'assign-properties', target: 'elements',
      selector: { type: 'column', coordinate: { axis: 'z', gt: 7.8 } }, values: { section: 'C3' } }] };
    const before = structuredClone(input);
    const model = await expandModellingOperations(input);
    expect(model.nodes).toHaveLength(80);
    expect(model.elements.filter(row => row.section === 'C3')).toHaveLength(20);
    expect(model.elements.filter(row => row.type === 'column' && row.section === 'C')).toHaveLength(40);
    expect(model.elements.filter(row => row.section === 'C3').every(row => row.story === 'g:F3')).toBe(true);
    expect(input).toEqual(before);
  });

  test('the same load-selector contract survives draft normalization without flattening edge and inner groups', () => {
    const loads = groups();
    const draft = normalizeEngineeringDraft({ loads });
    expect(draft.loads).toEqual(loads);
  });

  test('confirmed edge, inner and Y beam loads give DL 9423 kN and LL 1944 kN with a stable three-storey model', async () => {
    const model = await loadedFrame();
    expect(appliedLoadTotals(model)).toEqual({ DL: [0, 0, -9423], LL: [0, 0, -1944] });
    expect(checkModelPhysics(model, { loads: groups() })).toMatchObject({ valid: true, stability: { freeModes: 0 }, diagnostics: [] });
  });

  test('omitted and incorrectly assigned loads are rejected even when case totals are conserved', async () => {
    const model = await loadedFrame(), draft = { loads: groups() };
    const dl = model.load_cases.find(row => row.id === 'DL');
    const edge = dl.loads[0];
    const inner = dl.loads.find(load => load.wz === -34.5);
    [edge.wz, inner.wz] = [inner.wz, edge.wz];
    expect(appliedLoadTotals(model).DL).toEqual([0, 0, -9423]);
    const checked = checkModelPhysics(model, draft);
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics.some(row => row.code === 'LOAD_TARGET_MISMATCH')).toBe(true);
  });

  test.each([
    { ids: ['missing'] }, { type: 'beam', story: 'S3' }, { type: 'beam', parallelTo: 'z' },
  ])('unresolved group selectors cannot become an empty load case: %j', async selector => {
    const model = await loadedFrame();
    const checked = checkModelPhysics(model, { loads: [{ ...groups()[0], selector }] });
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics.some(row => row.severity === 'error')).toBe(true);
  });

  test('invalid selectors and conflicting target declarations fail without dropping fields', () => {
    for (const selector of [{ prose: 'all inner beams' }, { parallelTo: 'diagonal' }, { coordinate: { axis: 'z', gt: 'high' } }]) {
      expect(() => normalizeEngineeringDraft({ loads: [{ ...groups()[0], selector }] })).toThrow('LOAD_SELECTOR_INVALID');
    }
    expect(() => normalizeEngineeringDraft({ loads: [{ ...groups()[0], target: 'some-other-member' }] })).toThrow('LOAD_SELECTOR_CONFLICT');
    expect(() => normalizeEngineeringDraft({ loads: [{ ...groups()[0], location: { story: 2 } }] })).toThrow('LOAD_SELECTOR_CONFLICT');
  });

  test('an exhausted build receipt ends the turn, and a new user answer permits another operation', () => {
    const receipt = { role: 'tool', name: 'build_model', content: JSON.stringify({ success: false, modelBuilt: false,
      errorCode: 'OPERATION_SELECTOR_UNRESOLVED', terminal: true, details: { selector: { story: 'missing' } } }) };
    expect(() => assertNoTerminalSemanticFailure([{ role: 'user', content: 'Build' }, receipt])).toThrow('OPERATION_SELECTOR_UNRESOLVED');
    expect(() => assertNoTerminalSemanticFailure([receipt, { role: 'user', content: 'Use g:F3' }])).not.toThrow();
  });

  test('earlier accepted clarification proposals retain context without treating unselected alternatives as facts', () => {
    const answered = reply => ({ role: 'tool', name: 'ask_user_clarification', content: JSON.stringify({ type: 'clarification_answered', ...reply }) });
    const message = resolveExtractionInputMessage(undefined, undefined, [
      { role: 'user', content: 'Design the frame' },
      answered({ question: 'Edge rows A/D: 19.5; inner B/C: 34.5 kN/m. Accept?', answer: 'Accept', options: ['Accept', 'Use no loads'], selectedOptionId: 'option-1' }),
      answered({ question: 'Keep the third-storey column change?', answer: 'Yes' }),
    ]);
    expect(message).toContain('Edge rows A/D: 19.5; inner B/C: 34.5');
    expect(message).toContain('selectedOptionId');
    expect(message).toContain('unselected alternatives remain unconfirmed');
  });

  test('member endpoint selection is explicit and storey boundaries tolerate floating-point accumulation', async () => {
    const selection = selector => expandModellingOperations({ ...base(), operations: [grid,
      { id: 'top', op: 'assign-properties', target: 'elements', selector: { type: 'column', ...selector }, values: { section: 'C3' } }] });
    const model = await selection({ coordinate: { axis: 'z', at: 'start', gte: 7.8 } });
    expect(model.elements.filter(row => row.section === 'C3')).toHaveLength(20);
    await expect(selection({ coordinate: { axis: 'z', at: 'start', gt: 7.8 } })).rejects.toThrow('OPERATION_SELECTOR_UNRESOLVED');
  });

  test('build history preserves answered evidence while excluding failed candidates and unconfirmed assistant plans', () => {
    const history = modellingConversationHistory([
      { role: 'user', content: 'Design the frame' },
      { role: 'assistant', content: 'INCORRECT_CLAIM_THAT_STORY_ASSIGNMENT_IS_IMPOSSIBLE' },
      { role: 'tool', name: 'build_model', content: '{"oldCandidate":"REJECTED_MODEL"}' },
      { role: 'tool', name: 'ask_user_clarification', content: JSON.stringify({ type: 'clarification_answered',
        question: 'Use C30 or Q355?', options: ['C30', 'Q355'], answer: 'C30', selectedOptionId: 'option-1' }) },
    ]);
    expect(history).toContain('Design the frame');
    expect(history).toContain('Use C30 or Q355?');
    expect(history).toContain('selectedOptionId');
    expect(history).not.toContain('INCORRECT_CLAIM');
    expect(history).not.toContain('REJECTED_MODEL');
    expect(history).toContain('only actual answers or selected alternatives confirm values');
  });

  test('mixed explicit/generated stories agree geometrically; real identity conflicts remain errors', async () => {
    const input = { ...base(), stories: [{ id: 'g:F1', height: 4.2, elevation: 0 }, { id: 'g:F2', height: 3.6, elevation: 4.2 }], operations: [grid] };
    const snapshot = structuredClone(input);
    const model = await expandModellingOperations(input);
    expect(model.stories).toHaveLength(3);
    expect(input).toEqual(snapshot);
    input.stories[0].elevation = 9;
    await expect(expandModellingOperations(input)).rejects.toThrow('OPERATION_ID_COLLISION');
  });

  test('multiple geometric constraints select only the requested row and floor', async () => {
    const model = await expandModellingOperations({ ...base(), operations: [grid,
      { id: 'selected', op: 'assign-properties', target: 'elements', values: { section: 'C3' },
        selector: { type: 'beam', parallelTo: 'x', coordinates: [{ axis: 'y', eq: 0 }, { axis: 'z', eq: 7.8 }] } }] });
    expect(model.elements.filter(row => row.section === 'C3')).toHaveLength(4);
    expect(model.elements.filter(row => row.section === 'C3').every(row => row.story === 'g:F2')).toBe(true);
  });

  test('explicit story IDs map into all generated references without duplicate physical storeys', async () => {
    const stories = [
      { id: 'F1', height: 4.2, elevation: 0, rigid_diaphragm: false },
      { id: 'F2', height: 3.6, elevation: 4.2, rigid_diaphragm: false },
      { id: 'F3', height: 3.6, elevation: 7.8, rigid_diaphragm: false },
    ];
    await expect(expandModellingOperations({ ...base(), stories, operations: [grid] })).rejects.toThrow('OPERATION_STORY_ID_CONFLICT');
    const model = await expandModellingOperations({ ...base(), stories, operations: [{ ...grid, storyIds: { 1: 'F1', 2: 'F2', 3: 'F3' } }] });
    expect(model.stories).toEqual(stories);
    expect(model.nodes.filter(row => row.story === 'F3')).toHaveLength(20);
    expect(model.elements.filter(row => row.type === 'column' && row.story === 'F3')).toHaveLength(20);
  });

  test('confirmed reinforcement grades reach concrete members without defaults or changes to steel members', async () => {
    const { genericFixtures } = await import('../../../tests/characterization/fixtures/generic-physics.mjs');
    const { tryBuildGenericModelWithLlm } = await import('../../../dist/agent-skills/structure-type/generic/llm-model-builder.js');
    const candidate = structuredClone(genericFixtures[0].model);
    for (const material of candidate.materials) Object.assign(material, { grade: 'C30', category: 'concrete', E: 30000, nu: .2, rho: 2500 });
    candidate.materials.push({ id: 'STEEL', grade: 'Q355', category: 'steel', E: 206000, nu: .3, rho: 7850 });
    candidate.elements.at(-1).material = 'STEEL';
    candidate.elements[0].rebar_grade = 'HRB335';
    const member = candidate.elements[0];
    const state = { engineeringDraft: { material: { family: 'concrete', grade: 'C30', rebarGrade: 'HRB500' },
      topology: { members: [{ id: member.id, nodes: member.nodes, type: member.type, rebar_grade: 'HRB600' }] } } };
    const before = structuredClone(state);
    const model = await tryBuildGenericModelWithLlm({ invoke: async () => ({ content: JSON.stringify(candidate) }) }, 'Use the confirmed grades.', state, 'en');
    expect(model.elements[0]).toMatchObject({ concrete_grade: 'C30', rebar_grade: 'HRB600' });
    expect(model.elements[1]).toMatchObject({ concrete_grade: 'C30', rebar_grade: 'HRB500' });
    expect(model.elements.at(-1).rebar_grade).toBeUndefined();
    expect(state).toEqual(before);
  });

  const legacy = () => {
    const loads = groups().map(({ selector, ...load }) => ({ ...load, target: 'legacy-group', location: { story: Number(selector.story.split(':F')[1]) } }));
    const mappings = groups().map(load => {
      const { story, coordinate, ...selector } = load.selector;
      return { loadId: load.id, selector: { ...selector, coordinates: [...(coordinate ? [coordinate] : []),
        { axis: 'z', eq: [4.2, 7.8, 11.4][Number(story.split(':F')[1]) - 1] }] } };
    });
    return { loads, mappings };
  };

  test('LLM-authored identity mappings make legacy groups verifiable without changing confirmed inputs', async () => {
    const model = await loadedFrame(), { loads, mappings } = legacy();
    const draft = { geometry: { storyHeightsM: [4.2, 3.6, 3.6] }, loads };
    const before = structuredClone(draft);
    model.metadata.loadMappings = mappings;
    expect(checkModelPhysics(model, draft)).toMatchObject({ valid: true, diagnostics: [], loadTotals: { DL: [0, 0, -9423], LL: [0, 0, -1944] } });
    expect(checkModelPhysics(model, { model }).valid).toBe(true);
    expect(draft).toEqual(before);
    model.metadata.loadMappings = mappings.slice(1);
    expect(checkModelPhysics(model, draft).valid).toBe(false);
  });

  test.each(['duplicate', 'unknown', 'numeric-override', 'wrong-story', 'explicit-target'])('load mappings reject %s instead of changing user facts', async change => {
    const model = await loadedFrame(), { loads, mappings } = legacy();
    const draft = { geometry: { storyHeightsM: [4.2, 3.6, 3.6] }, loads };
    if (change === 'duplicate') mappings.push(structuredClone(mappings[0]));
    if (change === 'unknown') mappings[0].loadId = 'invented';
    if (change === 'numeric-override') mappings[0].magnitude = 0;
    if (change === 'wrong-story') mappings[0].selector.coordinates.at(-1).eq = 7.8;
    if (change === 'explicit-target') loads[0].target = model.elements[0].id;
    model.metadata.loadMappings = mappings;
    const checked = checkModelPhysics(model, draft);
    expect(checked.valid).toBe(false);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({ code: 'LOAD_TARGET_INVALID', severity: 'error',
      details: expect.objectContaining({ error: expect.stringContaining('LOAD_MAPPING_') }) }));
  });

  test('a specialized template cannot silently discard the new selector scope', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();
    const candidate = await loadedFrame();
    candidate.load_cases = [];
    runtime.registry.resolvePluginForState = async () => ({ id: 'test-template', handler: {
      computeMissing: () => ({ critical: [], optional: [] }), buildModel: () => candidate,
    } });
    await expect(runtime.buildModel({ inferredType: 'unknown', engineeringDraft: { loads: groups() } }))
      .rejects.toThrow('MODEL_PHYSICS_INVALID');
  });
});
