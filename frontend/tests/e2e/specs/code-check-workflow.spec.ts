import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beamModel, beamAnalysis } from '../fixtures/engineering-beam';
import { startLlmFixture, configureFixtureLlm, toolCall, type LlmFixture } from '../fixtures/llm-server';

const splitBeam = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../backend/tests/fixtures/design-edit-boundary-20261015.json'), 'utf8').replace(/^\uFEFF/, '')).model;
splitBeam.analysis_control = {self_weight:false,rigid_floor:false,rigid_offsets:false,p_delta:false,construction_stage:false};
const scenarios = [
  {name:'rectangle',model:beamModel,analysis:beamAnalysis,material:'steel',members:['beam'],load:'midpoint-load'},
  {name:'reported split numerical beam',model:splitBeam,analysis:{...beamAnalysis,loadCombinationIds:['ULS']},material:'1',members:['1','2'],load:'LC1:load:1'},
];
for (const locale of ['en', 'zh'] as const) for (const scenario of scenarios) {
  test(`Code checking through the browser (${locale}, ${scenario.name}): missing inputs, supplied conditions, real failure and truthful delivery`, async ({ page, request, baseURL }, info) => {
    test.setTimeout(180_000);
    const llm = await startLlmFixture();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await configureFixtureLlm(request, llm);
      await page.context().addCookies([{ name: 'structureclaw.locale', value: locale, url: baseURL! }]);
      await page.addInitScript(value => localStorage.setItem('structureclaw.locale', value), locale);
      await page.goto('/capabilities');
      await page.waitForLoadState('networkidle');
      await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.capabilities') ?? '{}').toolIds ?? []))
        .toEqual(expect.arrayContaining(['run_analysis', 'run_code_check', 'edit_model', 'generate_report']));
      const { skills } = await (await request.get('/api/v1/agent/skills')).json();
      for (const id of ['beam', 'opensees-static', 'validation-structure-model', 'report-export-builtin', 'code-check-gb50017']) {
        const skill = skills.find((skill: { id: string }) => skill.id === id);
        expect(skill).toBeTruthy();
        const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('structureclaw.console.capabilities') ?? '{}').skillIds ?? []);
        if (!selected.includes(id)) await page.getByRole('button', { name: skill.name[locale], exact: true }).click();
      }
      await page.goto('/');
      await page.getByRole('button', { name: /^(Context|工程上下文)$/ }).click();
      await page.getByPlaceholder(/Paste StructureModel v2 JSON here|将 StructureModel v2 JSON 粘贴/).fill(JSON.stringify(scenario.model));
      await page.keyboard.press('Escape');
      const message = `E2E-${locale}-${randomUUID().slice(0,8)}: Analyze and check the supplied beam, reporting missing conditions.`;
      // Deliberately unreliable prose must not override the real saved status.
      const initial = await send(page, llm, message, [toolCall('run_analysis', scenario.analysis),
        toolCall('run_code_check', { designCode: 'GB50017', provider: 'auto' }), 'UNVERIFIED_COMPLIANCE_SENTINEL: all checks passed, design complete.']);
      const missing = await lastCheck(request, initial);
      expect(missing).toMatchObject({ provider: 'builtin', engine: 'opensees', completionStatus: 'incomplete', complianceStatus: 'incomplete', conclusionEligible: false, nextAction: 'report_missing_inputs' });
      expect(missing.missingInputs.map((row: { field: string }) => row.field)).toEqual(expect.arrayContaining(['material.design.f', 'material.design.fv', 'member.design.deflectionLimitN', 'member.design.serviceability_result_keys']));
      await expect(page.locator('body')).not.toContainText('UNVERIFIED_COMPLIANCE_SENTINEL');
      const persisted = await (await request.get(`/api/v1/chat/conversation/${initial}`)).json();
      expect(persisted.messages.at(-1).content).not.toContain('UNVERIFIED_COMPLIANCE_SENTINEL');
      expect(persisted.messages.at(-1).content).toContain(locale === 'zh' ? '规范校核未全部完成' : 'Code checking is not complete');
      const before = await (await request.get(`/api/v1/chat/conversation/${initial}/session`)).json();
      const design = { beta1: 1, phi_b: 1, l0: 1000, lambdaLimit: 150, deflectionLimitN: 250, serviceability_result_keys: ['case:LC1'] };
      // Product fixture: these are expressly supplied conditions, not inferred defaults.
      await send(page, llm, 'Confirmed synthetic fixture conditions: f=215 MPa, fv=125 MPa; phi_b=1, effective length 1000 mm, lambda limit 150, beta1=1, btLimit=13; deflection L/250 under case:LC1. For the split custom numerical section also explicitly supply S=104 cm3, Wnx=237 cm3, tw=5.2 mm, imin=21 mm, b=40 mm, t=8.4 mm. These are declared test inputs, not inferred standard values. Update and reanalyze before checking.', [
        toolCall('edit_model', { baseRevision: before.modelRevision, edits: [
          { operation: 'update', collection: 'materials', id: scenario.material, values: { design: JSON.stringify({ f: 215, fv: 125 }) } },
          ...scenario.members.map(id => ({ operation:'update', collection:'elements', id, values:{design:JSON.stringify({...design,btLimit:13})} })),
          ...(scenario.name === 'rectangle' ? [] : [{operation:'update',collection:'sections',id:'SEC-I20A',values:{
            'properties.S':'.000104','properties.Wnx':'.000237','properties.tw':'.0052','properties.imin':'.021','properties.b':'.04','properties.t':'.0084',
          }}]),
        ] }), toolCall('run_analysis', scenario.analysis), toolCall('run_code_check', { designCode: 'GB50017', provider: 'builtin' }),
        toolCall('generate_report', { message: 'Computed checks under explicitly supplied fixture conditions', analysisType: 'static', locale, narrative: 'structured' }), 'CONFIRMED_CHECKS_DONE',
      ]);
      const complete = await lastCheck(request, initial);
      expect(complete).toMatchObject({ completionStatus: 'complete', complianceStatus: 'pass', conclusionEligible: true });
      expect(complete.summary.passed).toBeGreaterThan(0);
      expect(complete.summary.inputRequired).toBe(0);
      const session = await (await request.get(`/api/v1/chat/conversation/${initial}/session`)).json();
      expect(session.report.current).toBe(true);
      expect(session.analysis.runId).not.toBe(before.analysis.runId);

      await send(page, llm, 'Increase the existing load to 1000 kN, retain the supplied design conditions, reanalyze, check and report the actual result.', [
        toolCall('edit_model', { baseRevision: session.modelRevision, edits: [{ operation: 'update', collection: 'loads', caseId: 'LC1', id: scenario.load, values: { fz: -1000 } }] }),
        toolCall('run_analysis', scenario.analysis), toolCall('run_code_check', { designCode: 'GB50017' }),
        toolCall('generate_report', { message: 'Actual overloaded fixture result', analysisType: 'static', locale, narrative: 'structured' }), 'FALSE_PASS_SENTINEL: design meets all requirements.',
      ]);
      const failed = await lastCheck(request, initial);
      expect(failed.complianceStatus).toBe('fail');
      expect(failed.summary.failed).toBeGreaterThan(0);
      await expect(page.locator('body')).not.toContainText('FALSE_PASS_SENTINEL');
      const final = await (await request.get(`/api/v1/chat/conversation/${initial}`)).json();
      expect(final.messages.at(-1).content).toContain(locale === 'zh' ? '规范校核存在未通过项' : 'Code checking found failed items');
      await info.attach('saved-check-feedback', { body: JSON.stringify({ missing, complete, failed }, null, 2), contentType: 'application/json' });
      await info.attach('truthful-check-delivery', { body: await page.screenshot(), contentType: 'image/png' });
      expect(errors).toEqual([]);
      expect(llm.failures).toEqual([]);
      expect(llm.pending()).toBe(0);
    } finally { await llm.close(); }
  });
}

async function send(page: Page, llm: LlmFixture, message: string, replies: Parameters<LlmFixture['enqueue']>) {
  for (const name of ['Close Results', '关闭结果']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible()) await button.click();
  }
  llm.enqueue(...replies);
  const promised = page.waitForResponse(response => response.url().endsWith('/api/v1/chat/stream'));
  await page.locator('textarea[placeholder]').fill(message);
  await page.getByRole('button', { name: /^(Send|发送)$/ }).click();
  const response = await promised;
  expect(response.status()).toBe(200);
  expect(await response.finished()).toBeNull();
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events.filter(event => event.type === 'step_upsert' && event.step.status === 'error')).toEqual([]);
  await expect(page.locator('textarea[placeholder]')).toBeEnabled();
  return events.find(event => event.type === 'start').content.conversationId as string;
}

async function lastCheck(request: APIRequestContext, id: string) {
  const data = await (await request.get(`/api/v1/chat/conversation/${id}`)).json();
  return JSON.parse(data.messages.filter((message: { role: string; content: string }) => message.role === 'tool' && message.content.includes('"provider":"builtin"')).at(-1).content);
}
