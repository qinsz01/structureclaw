// Full API -> graph -> extraction -> build -> validation -> native solver -> saved report.
// Only LLM transport is scripted. Real provider acceptance is recorded separately.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startBackend, resolveOpenSeesPython } from './characterization/helpers/backend-host.mjs';
import { startLlmFixture, toolCall } from './characterization/helpers/llm-fixture.mjs';
import { structureCases, engines } from './fixtures/structure-engine-matrix.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
const directory = path.resolve(args.output ?? path.join(process.env.SCLAW_DATA_DIR ?? '.tmp', 'structure-engine-acceptance'));
await fs.mkdir(directory, { recursive: true });
const llm = await startLlmFixture();
let backend;
const receipts = [];
const seenResult = (requests, id) => {
  for (const request of [...requests].reverse()) {
    const message = request.body.messages?.find(item => item.role === 'tool' && item.tool_call_id === id);
    if (message) return JSON.parse(message.content);
  }
  return null;
};
const save = (name, body) => fs.writeFile(path.join(directory, name), JSON.stringify(body));
try {
  // Opt-in installation paths only; never import credentials, live work directories or database settings.
  const nativeSource = args['native-settings'] ? JSON.parse(await fs.readFile(args['native-settings'], 'utf8')) : {};
  const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
  const nativeSettings = args['native-settings'] ? {
    pkpm: pick(nativeSource.pkpm, ['cyclePath']),
    yjk: pick(nativeSource.yjk, ['installRoot', 'exePath', 'pythonBin', 'sdkArchivePath', 'version', 'timeoutS', 'launcherPrewarm', 'launcherPrewarmS', 'directReadyTimeoutS']),
  } : undefined;
  backend = await startBackend({ llmBaseUrl: llm.baseUrl, pythonBin: resolveOpenSeesPython() ?? '', nativeSettings });
  await save('references.json', structureCases);
  const availability = await backend.get('/engines');
  await save('engines.json', availability);
  const selectedEngines = engines.filter(id => (!args.engine || args.engine === id) && (!args.engines || args.engines.split(',').includes(id)));
  for (const id of selectedEngines) {
    const manifest = availability.body.engines.find(row => row.id === `builtin-${id.split('-')[0]}`);
    assert.equal(manifest?.available, true, `ENGINE_UNAVAILABLE: ${id}; configure its installation paths or explicitly select another test matrix`);
  }
  for (const fixture of structureCases.filter(row => (!args.case || row.id === args.case) && (!args.cases || args.cases.split(',').includes(row.id)))) {
    for (const engine of engines.filter(id => (!args.engine || args.engine === id) && (!args.engines || args.engines.split(',').includes(id)))) {
      const id = `${fixture.id}--${engine}`;
      const start = llm.requests.length;
      const prefix = `${id}-${Date.now()}`;
      const toolId = name => `${prefix}-${name}`;
      llm.setInternal((_body, record) => {
        if (record.kind === 'param-extractor') return JSON.stringify(fixture.draft);
        if (record.kind === 'structural-router') throw new Error('Fixed-skill selection must not route');
        if (fixture.model) return JSON.stringify(fixture.model);
        throw new Error(`Unexpected model-builder call for ${fixture.id}`);
      });
      llm.enqueue(toolCall('extract_draft_params', { locale: 'en' }, toolId('extract')),
        toolCall('build_model', {}, toolId('build')), toolCall('validate_model', {}, toolId('validate')),
        toolCall('run_analysis', { analysisType: 'static', analysisSkillId: engine, ...fixture.analysisArgs }, toolId('analyze')),
        (body) => {
          const receipt = seenResult([{ body }], toolId('analyze'));
          return receipt?.success ? toolCall('generate_report', { message: 'Report the requested analysis', analysisType: 'static', locale: 'en', narrative: 'structured' }, toolId('report')) : 'ANALYSIS_REFUSED';
        }, body => seenResult([{ body }], toolId('report')) ? 'MATRIX_DONE' : 'MATRIX_STOP');
      const record = { id, skillId: fixture.skillId, engine, expectedTotal: fixture.total, startedAt: new Date().toISOString() };
      try {
        const turn = await backend.stream({ message: `Execute these explicitly confirmed engineering inputs. Preserve geometry, IDs, material, loads and engine. Produce an analysis report; no code design. ${JSON.stringify(fixture.draft.engineeringDraft)}`,
          context: { locale: 'en', runPolicy: { skillIds: [fixture.skillId], routing: { mode: 'fixed', skillId: fixture.skillId } } } });
        // A refusal consumes its final response immediately; remove the unused report conclusion.
        if (llm.pending() === 1) llm.clearPending();
        record.turnErrors = turn.errors;
        const requests = llm.requests.slice(start);
        record.build = seenResult(requests, toolId('build'));
        record.validation = seenResult(requests, toolId('validate'));
        record.analysis = seenResult(requests, toolId('analyze'));
        record.report = seenResult(requests, toolId('report'));
        record.session = await backend.session(turn.conversationId);
        assert.deepEqual(record.session.modeling.usedSkillIds, [fixture.skillId], 'The selected structure skill must actually be used');
        const review = await backend.inputReview(turn.conversationId);
        // Full analysis delivery occurs repeatedly in SSE; keep the saved run once below.
        // The compact trace still pins tool calls, transport errors and model publication.
        await save(`${id}.json`, { ...record, model: review.model,
          turn: { steps: turn.steps, errors: turn.errors, interactions: turn.interactions, eventTypes: turn.events.map(event => event.type) }, requests });
        assert.equal(turn.errors.length, 0, 'SSE transport error');
        assert.equal(record.build?.success, true, `Build failed: ${JSON.stringify(record.build)}`);
        assert.equal(record.validation?.result?.valid, true, `Validation failed: ${JSON.stringify(record.validation)}`);
        const raw = turn.events.findLast(event => event.latestResult?.analysis)?.latestResult.analysis;
        record.failures = Object.entries(raw?.results ?? {}).filter(([, value]) => value.success === false)
          .map(([key, value]) => ({ key, code: value.error_code, message: value.message, meta: value.meta }));
        if (record.analysis?.success) {
          assert.equal(record.session.analysis.current, true);
          assert.equal(record.session.report.current, true);
          const run = await backend.get(`/runs/${record.session.analysis.runId}`);
          await save(`${id}.run.json`, run);
          record.reactionTotals = {};
          assert.deepEqual(Object.keys(run.body.results).sort(), Object.keys(fixture.expectedTotals).sort());
          for (const [key, expected] of Object.entries(fixture.expectedTotals)) {
            const result = run.body.results[key];
            assert.equal(result.meta.engineId, `builtin-${engine.split('-')[0]}`);
            assert.equal(result.meta.fallbackFrom, null);
            const totals = ['fx', 'fy', 'fz'].map(component => Object.values(result.data.reactions).reduce((sum, reaction) => {
              assert.equal(Number.isFinite(reaction[component]), true);
              return sum + reaction[component];
            }, 0));
            for (const [index, total] of expected.entries()) assert.ok(Math.abs(totals[index] + total) < 1e-3,
              `${key}: reaction imbalance ${totals} against frozen load ${expected}`);
            record.reactionTotals[key] = totals;
            if (key === 'case:DL' && fixture.axialDzM !== undefined) {
              const topIds = review.model.nodes.filter(node => node.z === 3.6).map(node => node.id);
              assert.equal(topIds.length, 4);
              for (const nodeId of topIds) assert.ok(Math.abs(result.data.displacements[nodeId].uz - fixture.axialDzM) < 1e-9,
                `${nodeId}: axial displacement must match the independent PL/EA reference`);
            }
            // Also verify a saved scalar through the same review tool the browser uses, in N.
            const nodeId = Object.keys(result.data.reactions)[0];
            const reviewResult = await backend.get(`/api/v1/agent/result-review/${turn.conversationId}`);
            const queried = await backend.post(`/api/v1/agent/result-review/${turn.conversationId}/tools`, {
              revisionToken: reviewResult.body.revisionToken, tool: 'query_results', args: {
                runId: record.session.analysis.runId, resultKey: key, nodeId, field: 'reactions', component: 'fz', unit: 'N', quantityId: `${key}-${nodeId}-fz` } });
            assert.equal(queried.body.success, true, JSON.stringify(queried));
            assert.ok(Math.abs(queried.body.result.quantity.value - result.data.reactions[nodeId].fz * 1000) < .01);
          }
          for (const check of fixture.referenceChecks ?? []) {
            const node = review.model.nodes.find(node => node.x === check.x && node.y === (check.y ?? 0) && node.z === (check.z ?? 0));
            assert.ok(node, 'The independently specified response location must exist');
            const value = run.body.results[check.resultKey].data[check.field][node.id][check.component];
            assert.ok(Number.isFinite(value) && Math.abs(value - check.value) < check.tolerance,
              `Independent closed-form response mismatch: ${value} vs ${check.value}`);
          }
          record.outcome = 'solved';
        } else {
          assert.equal(record.session.analysis?.current ?? false, false);
          assert.equal(record.session.report?.current ?? false, false);
          assert.ok(record.failures.length > 0, 'Failure must retain its source result');
          for (const failure of record.failures) {
            assert.ok(['ENGINE_INPUT_UNSUPPORTED', 'ENGINE_MODEL_FAMILY_UNSUPPORTED', 'ENGINE_UNSUPPORTED'].includes(failure.code), JSON.stringify(failure));
            assert.equal(failure.meta.fallbackFrom ?? null, null);
          }
          record.outcome = 'refused';
        }
        assert.equal(record.outcome, engine === 'opensees-static' ? 'solved' : fixture.expectedNative[engine]);
      } catch (error) {
        record.outcome = 'failed';
        record.error = error.stack;
        await save(`${id}.failure.json`, { ...record, fixture, logs: backend.logs(), requests: llm.requests.slice(start) });
        llm.clearPending();
      }
      record.finishedAt = new Date().toISOString();
      receipts.push(record);
      await save('summary.json', receipts);
      console.log(JSON.stringify({ id, outcome: record.outcome, error: record.error?.split('\n')[0], analysis: record.analysis?.errorCode ?? record.analysis?.error_code }));
    }
  }
  await save('fixture-failures.json', llm.failures);
} finally {
  if (backend) await fs.writeFile(path.join(directory, 'backend.log'), backend.logs());
  await backend?.close();
  await llm.close();
}
if (receipts.some(record => record.outcome === 'failed') || llm.failures.length) process.exitCode = 1;
