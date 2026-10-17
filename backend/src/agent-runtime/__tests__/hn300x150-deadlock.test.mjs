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

describe('defect 1: the blocking section reason reaches the agent and the question in both locales', () => {
  test('a catalog designation without geometry names the section, the designation and the accepted inputs', () => {
    const state = scenario('catalogNameWithoutGeometry');
    const [issue] = templatePropertyIssues(state);
    const [en, zh] = issue.replace(/^[A-Z_]+:\s*/, '').split(' / ');
    expect(en).toContain('section SEC1');
    expect(en).toContain('HN300x150x6.5x9');
    expect(en).toMatch(/not in the reviewed section catalog/);
    expect(en).toContain('300×150×6.5×9');
    expect(zh).toContain('SEC1');
    expect(zh).toContain('HN300x150x6.5x9');
    expect(zh).toMatch(/已审定截面目录/);
    expect(zh).not.toBe('请明确材料、截面与构件角色对应关系后再建模');
  });

  test('a two-dimension designation asks for explicit H×B×tw×tf and names only reviewed catalog sections', () => {
    const state = withSection(scenario('catalogNameWithoutGeometry'),
      { id: 'SEC1', name: 'HN300x150', type: 'H', purpose: 'beam', standard_steel_name: 'HN300x150' });
    const [en, zh] = templatePropertyIssues(state)[0].replace(/^[A-Z_]+:\s*/, '').split(' / ');
    for (const text of [en, zh]) {
      expect(text).toContain('HN300x150');
      expect(text).toContain('H×B×tw×tf');
      expect(text).toContain('I20a');
      expect(text).not.toMatch(/6\.5|×9\b/);
    }
  });

  test.each(['en', 'zh'])('the %s clarification question carries the specific section reason', locale => {
    const state = scenario('catalogNameWithoutGeometry');
    const missing = computeDraftMissing(plugin, state, 'execution');
    expect(missing.critical).toEqual(['templateProperties']);
    const question = buildDraftQuestions(plugin, missing.critical, missing.optional, state, locale)
      .find(item => item.paramKey === 'templateProperties');
    expect(question.question).toContain('SEC1');
    expect(question.question).toContain('HN300x150x6.5x9');
    expect(question.question).not.toContain(' / ');
    expect(question.question).toMatch(locale === 'zh' ? /已审定截面目录/ : /not in the reviewed section catalog/);
  });

  test('build_model rejects with the specific blocking reason instead of only templateProperties', async () => {
    const state = scenario('catalogNameWithoutGeometry');
    await expect(new AgentSkillRuntime().buildModel(state, ['beam'], { locale: 'zh' }))
      .rejects.toThrow(/MODEL_DRAFT_INCOMPLETE: templateProperties.*section SEC1 \(HN300x150x6\.5x9\)/s);
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

  test('materials.E stays unresolved while any material lacks a valid E, with its target stable', () => {
    const state = scenario('unqualifiedMaterialField');
    delete state.engineeringDraft.materials[0].E;
    const current = currentDraftDiagnostics(state);
    expect(current.draftIssues).toEqual([expect.objectContaining({ field: 'materials.E', target: 'materials["M1"].E' })]);
    const two = scenario('unqualifiedMaterialField');
    two.engineeringDraft.materials.push({ id: 'M2', name: 'other', nu: 0.3, rho: 7850 });
    expect(unresolvedDraftFields(currentDraftDiagnostics(two))).toEqual(['materials.E']);
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
