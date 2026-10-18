import { expect, test } from '@jest/globals';
import { codeCheckFeedback, compactCodeCheckFeedback, codeCheckDeliveryNotice, validateServiceabilitySelection } from '../dist/engineering/code-checks.js';
import { readFile } from 'node:fs/promises';
import { ToolMessage } from '@langchain/core/messages';
import { projectToolMessagesForContext } from '../dist/agent-langgraph/graph.js';

test('the actual incomplete-check response is compacted without losing inputs, units, owners or computed evidence', async () => {
  const original = JSON.parse(await readFile(new URL('./fixtures/code-check-context-20261016.json', import.meta.url), 'utf8'));
  const saved = structuredClone(original);
  const compact = compactCodeCheckFeedback(original);
  const expand = rows => rows.flatMap(({ appliesTo, ...shared }) => appliesTo.map(binding => ({ ...shared, ...binding })));
  const unordered = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort();
  expect(unordered(expand(compact.checkedItems.items))).toEqual(unordered(original.checkedItems.items));
  expect(unordered(expand(compact.missingInputs))).toEqual(unordered(original.missingInputs));
  expect(compact).toMatchObject({ completionStatus: 'incomplete', complianceStatus: 'incomplete', conclusionEligible: false });
  expect(compact.inputRequiredChecks).toBeUndefined();
  expect(compact.writeTargets).toBeUndefined();
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length * .8);
  expect(original).toEqual(saved);
  const message = new ToolMessage({ id: 'saved', tool_call_id: 'check', name: 'run_code_check', content: JSON.stringify(original) });
  const [projected] = projectToolMessagesForContext([message]);
  expect(projected).toMatchObject({ id: 'saved', tool_call_id: 'check', name: 'run_code_check' });
  expect(JSON.parse(projected.content)).toEqual(JSON.parse(JSON.stringify(compact)));
  expect(JSON.parse(message.content)).toEqual(saved);
  const unfamiliar = { ...original, writeTargets: [...original.writeTargets, { externalField: 'retain-me' }],
    inputRequiredChecks: [...original.inputRequiredChecks, { check: 'unsupported-extension', reason: 'retain-me' }] };
  expect(compactCodeCheckFeedback(unfamiliar)).toMatchObject({ writeTargets: [{ externalField: 'retain-me' }],
    inputRequiredChecks: [{ check: 'unsupported-extension', reason: 'retain-me' }] });
});

test('context projection preserves failures and non-check tool responses verbatim', () => {
  for (const [name, content] of [['run_code_check', 'Error: missing engine'], ['run_code_check', '{"success":false,"errorCode":"CURRENT_ANALYSIS_REQUIRED"}'],
    ['query_results', '{"quantity":{"value":-2.5,"unit":"kN.m","side":"left"}}']]) {
    const message = new ToolMessage({ name, content, tool_call_id: 'fixture' });
    expect(projectToolMessagesForContext([message])[0]).toBe(message);
  }
});
import { createRunCodeCheckTool } from '../dist/agent-langgraph/tools.js';
import { beginAnalysisRequest } from '../dist/engineering/model-state.js';
import { prepareEngineeringReport, finishEngineeringReport } from '../dist/agent-runtime/engineering-report.js';

test('computed feedback preserves separate stress and stability evidence without inventing missing values', () => {
  const items = [
    { item: '正应力', status: 'pass', utilization: 0.0491, formula: '(|N|/A + |M|/Wnx) / f <= 1',
      inputs: { demand: 2500000 / 237000, capacity: 215, unit: 'MPa' } },
    { item: '整体稳定', status: 'pass', utilization: 0.0545, formula: 'M / (phi_b * Wx * f) <= 1',
      inputs: { demand: 2500000, capacity: 0.9 * 237000 * 215, unit: 'N.mm' }, forceState: { positionM: 5, side: 'left' } },
    { item: '缺资料', status: 'input_required', formula: 'Requires declared data', missingInputs: [] },
  ];
  const check = { meta: { runId: 'checked-run' }, details: [{ elementId: 'beam-1', resultKey: 'case:LC1', checks: [{ items }] }] };
  const feedback = codeCheckFeedback(check);
  expect(feedback.checkedItems).toMatchObject({ runId: 'checked-run', totalCount: 3, truncated: false });
  const rows = feedback.checkedItems.items;
  expect(rows[0]).toMatchObject({ elementId: 'beam-1', resultKey: 'case:LC1', check: '正应力', inputs: items[0].inputs, formula: items[0].formula });
  expect(rows[1]).toMatchObject({ elementId: 'beam-1', resultKey: 'case:LC1', check: '整体稳定', inputs: items[1].inputs, forceState: items[1].forceState });
  expect(rows[2].inputs).toBeUndefined();
  expect(rows[2].utilization).toBeUndefined();
  expect(feedback.guidance).toContain('Never combine coefficients');
  check.details = Array.from({ length: 101 }, (_, i) => ({ elementId: String(i), resultKey: 'case:LC1', checks: [{ items: [items[0]] }] }));
  const limited = codeCheckFeedback(check).checkedItems;
  expect(limited).toMatchObject({ totalCount: 101, truncated: true });
  expect(limited.items).toHaveLength(100);
});

test.each(['incomplete', 'fail'])('a report cannot accept a fabricated pass narrative for %s checks', status => {
  const check = { completionStatus: status === 'fail' ? 'complete' : 'incomplete', complianceStatus: status,
    summary: { total: 1, passed: 0, failed: status === 'fail' ? 1 : 0, inputRequired: status === 'incomplete' ? 1 : 0 }, meta: { runId: 'run' } };
  const prepared = prepareEngineeringReport({ message: 'report', analysisType: 'static', locale: 'zh',
    analysis: { success: true, runId: 'run', meta: {} }, codeCheck: check });
  const result = finishEngineeringReport(prepared, 'FALSE_PASS_SENTINEL: all requirements met');
  expect(result.markdown).not.toContain('FALSE_PASS_SENTINEL');
  expect(result.json.codeCheck.complianceStatus).toBe(status);
});

test('feedback deduplicates missing fields across cases while keeping member and check identities', () => {
  const result = { completionStatus: 'incomplete', complianceStatus: 'incomplete', summary: { inputRequired: 2 },
    details: ['case:D', 'case:L'].map(resultKey => ({ elementId: 'beam', resultKey,
      checks: [{ items: [{ item: '正应力', status: 'input_required', missingInputs: [{ field: 'material.design.f', label: 'Design strength', unit: 'MPa', source: 'design' }] }] }] })) };
  const feedback = codeCheckFeedback(result);
  expect(feedback.missingInputs).toHaveLength(1);
  expect(feedback.missingInputs[0]).toMatchObject({ elementId: 'beam', field: 'material.design.f', resultKeys: ['case:D', 'case:L'] });
  expect(feedback.conclusionEligible).toBe(false);
  expect(codeCheckDeliveryNotice(result, 'zh')).toContain('不能给出设计合格结论');
  expect(codeCheckDeliveryNotice({ completionStatus: 'complete', complianceStatus: 'fail', summary: { failed: 1 } }, 'en')).toContain('failed items');
});

test.each([
  ['zh', '已完成的校核', '未执行的校核及所缺输入', '后续消息'],
  ['en', 'Checks performed', 'Checks not performed and missing inputs', 'later message'],
])('an incomplete check is delivered with performed and not-performed checks in %s, without asking', (locale, performed, notPerformed, later) => {
  const result = { completionStatus: 'incomplete', complianceStatus: 'incomplete', summary: { total: 2, passed: 1, inputRequired: 1 },
    details: [{ elementId: 'beam', resultKey: 'case:LC1', checks: [{ items: [
      { item: '剪应力', clause: 'GB50017-2017 7.1.2', status: 'pass', utilization: 0.12 },
      { item: '正应力', clause: 'GB50017-2017 7.1.1', status: 'input_required',
        missingInputs: [{ field: 'material.design.f', label: '抗拉抗压抗弯设计强度 / Design normal strength', unit: 'MPa', source: 'design' }] },
    ] }] }] };
  expect(codeCheckFeedback(result).nextAction).toBe('report_missing_inputs');
  const notice = codeCheckDeliveryNotice(result, locale);
  expect(notice).toContain(performed);
  expect(notice).toContain('剪应力 / Shear stress [GB50017-2017 7.1.2]: pass');
  expect(notice).toContain('0.120');
  expect(notice).toContain(notPerformed);
  expect(notice).toContain('正应力 / Normal stress [GB50017-2017 7.1.1]: 抗拉抗压抗弯设计强度 / Design normal strength (MPa)');
  expect(notice).toContain(later);
});

test('OpenSees native-design mismatch explains the correct provider without submitting a commercial job', async () => {
  const state = { model: { nodes: [], elements: [], materials: [], sections: [] }, modelRevision: 1 };
  state.analysisRequest = beginAnalysisRequest(state, 'fixture').analysisRequest;
  state.analysisResult = { success: true, meta: { ...state.analysisRequest, engineId: 'builtin-opensees' } };
  const runtime = { resolveCodeCheckDesignCodeFromSkillIds: () => 'GB50017', resolveCodeCheckSkillId: () => 'code-check-gb50017' };
  const result = await createRunCodeCheckTool(runtime).invoke({ designCode: 'GB50017', provider: 'native', design: { mode: 'code-check' } },
    { toolCall: { id: 'native-mismatch' }, configurable: { agentState: state } });
  const payload = JSON.parse(result.update.messages[0].content);
  expect(payload).toMatchObject({ success: false, errorCode: 'NATIVE_DESIGN_ENGINE_REQUIRED', engine: 'opensees', allowedProviders: ['auto', 'builtin'] });
  expect(payload.messageZh).toContain('不是 StructureClaw 需要付费版本');
});

test('feedback locates shared material and section owners and states explicit input-to-model unit conversion', () => {
  const model = { elements: ['1','2'].map(id => ({ id, material:'steel', section:'s' })) };
  const check = { details: ['1','2'].map(elementId => ({ elementId, resultKey:'case:S', checks:[{ items:[{ item:'design', status:'input_required', missingInputs:[
    { field:'material.design.f', unit:'MPa' }, { field:'section.S', unit:'mm3' }, { field:'response.deflection', unit:'mm', source:'result' },
  ] }] }] })) };
  const feedback = codeCheckFeedback(check, model, { results:{'case:S':{}} });
  expect(feedback.writeTargets).toEqual(expect.arrayContaining([
    expect.objectContaining({ collection:'materials', id:'steel', path:'design.f', modelUnit:'MPa', elementIds:['1','2'] }),
    expect.objectContaining({ collection:'sections', id:'s', path:'properties.S', modelUnit:'m3', inputToModelScale:1e-9, elementIds:['1','2'] }),
  ]));
  expect(feedback.writeTargets).toHaveLength(2);
  expect(feedback.missingInputs.filter(row => row.field === 'response.deflection').every(row => row.writable === false)).toBe(true);
});

test('a misspelled or absent service result key is rejected before any check is made inapplicable', () => {
  const model = { elements:[{id:'beam', design:{ serviceability_result_keys:['case:S'] }}] };
  expect(() => validateServiceabilitySelection(model, { results:{'case:S':{},'combination:ULS':{}} })).not.toThrow();
  expect(() => validateServiceabilitySelection(model, { results:{'combination:ULS':{}} })).toThrow(/SERVICEABILITY_RESULT_UNAVAILABLE/);
});



test('missing computed responses lead to analysis inspection, while unselected service cases are reported without an interrupt', () => {
  const make = fields => ({ completionStatus: 'incomplete', complianceStatus: 'incomplete',
    details: [{ elementId: 'B1', checks: [{ items: [{ item: '挠度', status: 'input_required', missingInputs: fields }] }] }] });
  const response = { field: 'response.deflection', unit: 'mm', source: 'result' };
  expect(codeCheckFeedback(make([response])).nextAction).toBe('inspect_analysis');
  expect(codeCheckFeedback(make([response, { field: 'member.design.serviceability_result_keys', source: 'design' }])).nextAction).toBe('report_missing_inputs');
  expect(codeCheckFeedback({ completionStatus: 'incomplete', summary: { unsupported: 1 } }).nextAction).toBe('inspect_capability');
});

test.each(['zh', 'en'])('selected checks are reported as a limited scope in %s, never complete design compliance', locale => {
  const check = { completionStatus: 'complete', complianceStatus: 'pass', summary: { total: 7, passed: 1, notApplicable: 6 },
    checkScope: { mode: 'selected', limited: true, elements: { B1: { requestedChecks: ['正应力'], omittedChecks: ['整体稳定'] } } }, meta: { runId: 'run' } };
  const feedback = codeCheckFeedback(check);
  expect(feedback.conclusionEligible).toBe(false);
  expect(feedback.requestedChecksPassed).toBe(true);
  expect(feedback.nextAction).toBe('deliver_results');
  const notice = codeCheckDeliveryNotice(check, locale);
  expect(notice).toContain('正应力');
  expect(notice).toContain(locale === 'zh' ? '其余项目未校核' : 'Other checks were not requested');
  const prepared = prepareEngineeringReport({ message: 'report selected checks', analysisType: 'static', locale,
    analysis: { success: true, runId: 'run', meta: {} }, codeCheck: check });
  const report = finishEngineeringReport(prepared, 'FALSE_FULL_DESIGN_PASS_SENTINEL');
  expect(report.markdown).not.toContain('FALSE_FULL_DESIGN_PASS_SENTINEL');
  expect(report.markdown).toContain(locale === 'zh' ? '未请求项目未校核' : 'Unrequested checks were not performed');
  expect(report.json.codeCheck.checkScope).toEqual(check.checkScope);
});
