// Regression for the 2026-10-17 live-acceptance deadlock: "简支钢梁，跨度6m，跨中集中荷载10kN，Q355，
// H型钢 HN300x150，用OpenSees静力分析并出报告" (zh and en) never reached analysis. Each scenario is a
// minimised saved DraftState from that run (tests/fixtures/hn300x150-deadlock-20261017.json).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/beam/handler.js';
import { computeDraftMissing, buildDraftQuestions } from '../../../dist/agent-runtime/draft-readiness.js';
import { templatePropertyIssues } from '../../../dist/agent-runtime/template-properties.js';
import { currentDraftDiagnostics, mergeDraftDiagnostics, unresolvedDraftFields } from '../../../dist/agent-runtime/draft-diagnostics.js';
import { AgentSkillRuntime } from '../../../dist/agent-runtime/index.js';
import { createAskUserClarificationTool } from '../../../dist/agent-langgraph/tools.js';
import { resolveRunPolicy } from '../../../dist/runtime/run-policy.js';
import { createRunContext, withRunContext } from '../../../dist/runtime/run-context.js';

const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/hn300x150-deadlock-20261017.json', import.meta.url), 'utf8'));
const scenario = id => structuredClone(fixture.scenarios[id].state);
const plugin = { id: 'beam', handler };
const withSection = (state, section) => ({ ...state, engineeringDraft: { ...state.engineeringDraft,
  sectionRecords: [section], sections: { beam: section.name } } });

describe('defect 1: a designation is a label; four dimensions are geometry, two dimensions ask for tw/tf', () => {
  test('a four-dimension designation without shape is read as sharp-corner H geometry, not a catalog lookup', async () => {
    const state = scenario('catalogNameWithoutGeometry');
    expect(templatePropertyIssues(state)).toEqual([]);
    expect(computeDraftMissing(plugin, state, 'execution').critical).toEqual([]);
    const model = await new AgentSkillRuntime().buildModel(state, ['beam'], { locale: 'zh' });
    expect(model.sections[0]).toMatchObject({ id: 'SEC1', name: 'HN300x150x6.5x9', shape: { kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 } });
    expect(model.sections[0]).not.toHaveProperty('standard_steel_name');
    // Properties are derived from the shape by the deterministic V2 geometry normalization.
    expect(model.sections[0].properties).toBeUndefined();
  });

  test('a two-dimension designation asks for tw/tf and offers no catalog sections', () => {
    const state = withSection(scenario('catalogNameWithoutGeometry'),
      { id: 'SEC1', name: 'HN300x150', type: 'H', purpose: 'beam', standard_steel_name: 'HN300x150' });
    const [en, zh] = templatePropertyIssues(state)[0].replace(/^[A-Z_]+:\s*/, '').split(' / ');
    expect(en).toContain('section SEC1 (HN300x150)');
    expect(en).toContain('web thickness tw and flange thickness tf');
    expect(zh).toContain('截面 SEC1（HN300x150）');
    expect(zh).toContain('腹板厚 tw 和翼缘厚 tf');
    for (const text of [en, zh]) {
      expect(text).not.toMatch(/catalog|目录|I20a/);
      expect(text).not.toMatch(/6\.5|×9\b/);
    }
  });

  test.each(['en', 'zh'])('the %s clarification question carries the specific section reason', locale => {
    const state = withSection(scenario('catalogNameWithoutGeometry'),
      { id: 'SEC1', name: 'HN300x150', type: 'H', purpose: 'beam', standard_steel_name: 'HN300x150' });
    const missing = computeDraftMissing(plugin, state, 'execution');
    expect(missing.critical).toEqual(['templateProperties']);
    const question = buildDraftQuestions(plugin, missing.critical, missing.optional, state, locale)
      .find(item => item.paramKey === 'templateProperties');
    expect(question.question).toContain('SEC1');
    expect(question.question).toContain('HN300x150');
    expect(question.question).not.toContain(' / ');
    expect(question.question).toMatch(locale === 'zh' ? /腹板厚 tw 和翼缘厚 tf/ : /web thickness tw and flange thickness tf/);
  });

  test('build_model rejects with the specific blocking reason instead of only templateProperties', async () => {
    const state = withSection(scenario('catalogNameWithoutGeometry'),
      { id: 'SEC1', name: 'HN300x150', type: 'H', purpose: 'beam', standard_steel_name: 'HN300x150' });
    await expect(new AgentSkillRuntime().buildModel(state, ['beam'], { locale: 'zh' }))
      .rejects.toThrow(/MODEL_DRAFT_INCOMPLETE: templateProperties.*section SEC1 \(HN300x150\)/s);
  });

  test('ask_user_clarification drops options the template would reject and keeps explicit geometry', async () => {
    const draftState = withSection(scenario('catalogNameWithoutGeometry'),
      { id: 'SEC1', name: 'HN300x150', type: 'H', purpose: 'beam', standard_steel_name: 'HN300x150' });
    const options = ['按国标目录 HN300x150 取截面属性', '按 H300x150x6.5x9（H×B×tw×tf，mm）理想化几何建模', '我稍后提供截面尺寸'];
    const policy = resolveRunPolicy({ availableSkillIds: [], availableToolIds: ['ask_user_clarification'],
      defaultToolIds: ['ask_user_clarification'], executionOwner: 'external' });
    const result = JSON.parse(await withRunContext(createRunContext(policy), () => createAskUserClarificationTool().invoke(
      { question: '请确认截面', optionsJson: JSON.stringify(options) }, { configurable: { agentState: { draftState, messages: [] } } })));
    expect(result.options).toEqual(options.slice(1));
  });
});

describe('defect 2: an unqualified collection field resolves against the collection records', () => {
  test('materials.E clears once the only material declares a valid E and is retargeted to its stable ID', () => {
    const state = scenario('unqualifiedMaterialField');
    expect(state.draftIssues.map(issue => issue.field)).toEqual(['materials.E']);
    const current = currentDraftDiagnostics(state);
    expect(unresolvedDraftFields(current)).toEqual([]);
    expect(computeDraftMissing(plugin, state, 'execution').critical).toEqual([]);
  });

  test('materials.E stays unresolved while any material lacks a valid E and a supported grade, with its target stable', () => {
    const state = scenario('unqualifiedMaterialField');
    delete state.engineeringDraft.materials[0].E;
    state.engineeringDraft.materials[0].grade = 'Q999';
    state.engineeringDraft.materials[0].name = 'user steel';
    const current = currentDraftDiagnostics(state);
    expect(current.draftIssues).toEqual([expect.objectContaining({ field: 'materials.E', target: 'materials["M1"].E' })]);
    const two = scenario('unqualifiedMaterialField');
    two.engineeringDraft.materials.push({ id: 'M2', name: 'other', nu: 0.3, rho: 7850 });
    expect(unresolvedDraftFields(currentDraftDiagnostics(two))).toEqual(['materials.E']);
  });

  test('a material record that declares only a supported grade gets that grade\'s elastic constants (2026-10-18 live en)', async () => {
    const state = scenario('unqualifiedMaterialField');
    state.engineeringDraft.materials = [{ id: 'M1', name: 'Q355', grade: 'Q355', category: 'steel' }];
    state.draftIssues = [{ field: 'materials["M1"].E', kind: 'missing', severity: 'invalid', reason: 'E not supplied', target: 'materials["M1"].E' }];
    state.skillState = { ...state.skillState, invalidDraftFields: ['materials["M1"].E'] };
    expect(unresolvedDraftFields(currentDraftDiagnostics(state))).toEqual([]);
    expect(computeDraftMissing(plugin, state, 'execution').critical).toEqual([]);
    const model = await new AgentSkillRuntime().buildModel(state, ['beam'], { locale: 'en' });
    expect(model.materials[0]).toMatchObject({ id: 'M1', grade: 'Q355', E: 206000, G: 79000, nu: 0.3, rho: 7850 });
    // An explicit E is never replaced, and an unknown grade still asks for its properties.
    state.engineeringDraft.materials = [{ id: 'M1', name: 'Q355', grade: 'Q355', E: 200000, nu: 0.3, rho: 7850 }];
    expect((await new AgentSkillRuntime().buildModel(state, ['beam'], { locale: 'en' })).materials[0].E).toBe(200000);
    state.engineeringDraft.materials = [{ id: 'M1', name: 'Q999', grade: 'Q999' }];
    expect(computeDraftMissing(plugin, state, 'execution').critical).toEqual(['materials.M1.E', 'materials.M1.nu', 'materials.M1.rho']);
  });

  test('the en conversation state builds a model', async () => {
    const model = await new AgentSkillRuntime().buildModel(scenario('unqualifiedMaterialField'), ['beam'], { locale: 'en' });
    expect(model.materials[0]).toMatchObject({ id: 'M1', E: 206000 });
  });
});

describe('defect 3: a role-section confirmation clears when the answer supplies the assigned section', () => {
  const answered = () => {
    const merged = scenario('roleSectionConfirmation');
    const existing = structuredClone(merged);
    delete existing.engineeringDraft.sectionRecords[0].shape;
    existing.engineeringDraft.sectionRecords[0].standard_steel_name = 'HN300x150';
    return { existing, merged };
  };

  test('a complete section record assigned to the beam role clears sections.beam', () => {
    const { existing, merged } = answered();
    const patch = { engineeringDraft: { sectionRecords: [{ id: 'SEC-B1', shape: { kind: 'H', H: 300, B: 150, tw: 6.5, tf: 9 } }] } };
    expect(mergeDraftDiagnostics(existing, patch, merged).draftIssues).toBeUndefined();
  });

  test('a new template assignment to a complete record clears sections.beam', () => {
    const merged = scenario('roleSectionConfirmation');
    const patch = { engineeringDraft: { templateAssignments: { beam: { materialId: 'MAT-Q355', sectionId: 'SEC-B1' } } } };
    expect(mergeDraftDiagnostics(merged, patch, merged).draftIssues).toBeUndefined();
  });

  test('without a new answer, or with an incomplete assigned record, the confirmation remains', () => {
    const merged = scenario('roleSectionConfirmation');
    expect(unresolvedDraftFields(currentDraftDiagnostics(merged))).toEqual(['sections.beam']);
    const { existing } = answered();
    const patch = { engineeringDraft: { sectionRecords: [{ id: 'SEC-B1', name: 'HN300x150' }] } };
    expect(mergeDraftDiagnostics(existing, patch, existing).draftIssues?.map(issue => issue.field)).toEqual(['sections.beam']);
  });

  test('an unrelated patch does not clear the confirmation', () => {
    const merged = scenario('roleSectionConfirmation');
    const patch = { engineeringDraft: { geometry: { lengthM: 6 } } };
    expect(mergeDraftDiagnostics(merged, patch, merged).draftIssues?.map(issue => issue.field)).toEqual(['sections.beam']);
  });
});
