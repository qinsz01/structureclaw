import { afterAll, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Fastify from 'fastify';
import { AIMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-agent-entry-'));
process.env.SCLAW_DATA_DIR = temporary;
const { getAgentService } = await import('../dist/agent-langgraph/index.js');
const { agentRoutes } = await import('../dist/api/agent.js');
const { AgentStateAnnotation } = await import('../dist/agent-langgraph/state.js');
const { FileCheckpointer } = await import('../dist/agent-langgraph/file-checkpointer.js');
const { createAskUserClarificationTool } = await import('../dist/agent-langgraph/tools.js');
const { executeToolsSequentially } = await import('../dist/agent-langgraph/sequential-tools.js');
const { withRunContext, snapshotRunUsage, requestRecovery, reserveLlmCall } = await import('../dist/runtime/run-context.js');
const service = getAgentService();
service.skillRuntime = { listSkillManifests: async () => [{ id: 'generic' }] };
const app = Fastify();
await app.register(agentRoutes, { prefix: '/api/v1/agent' });
await app.ready();
afterAll(async () => {
  await app.close();
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('sclaw-agent-entry-')) throw new Error('Invalid fixture directory');
  fs.rmSync(temporary, { recursive: true, force: true });
});

function graphFor(id, { ask = false, failAfterResume = false, chargeBeforePause = false } = {}) {
  let observed;
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode('agent', (state, config) => {
      observed = state;
      if (chargeBeforePause) withRunContext(config.configurable.runContext, () => {
        // Charge the real ledger without a network/model call, to detect resets on resume.
        reserveLlmCall('fixture-no-network'); requestRecovery('fixture-prior-correction');
      });
      return { runUsage: snapshotRunUsage(config.configurable.runContext), messages: [new AIMessage(ask
        ? { content: '', tool_calls: [{ id: `question-${id}`, name: 'ask_user_clarification', args: {
          question: state.locale === 'zh' ? '支座是什么？' : 'Which support?', options: ['Pinned', 'Fixed'],
        } }] }
        : { content: 'Parsed / 已解析' })] };
    }).addEdge(START, 'agent');
  if (ask) graph.addNode('tools', (state, config) => withRunContext(config.configurable.runContext,
      () => executeToolsSequentially([createAskUserClarificationTool()], state, config)))
    .addNode('finish', state => {
      if (failAfterResume) throw new Error('FIXTURE_RESUME_FAILURE');
      observed = state;
      return { messages: [new AIMessage({ content: `Received / 已接收: ${state.messages.at(-1).content}` })] };
    }).addEdge('agent', 'tools').addEdge('tools', 'finish').addEdge('finish', END);
  else graph.addEdge('agent', END);
  const compiled = graph.compile({ checkpointer: new FileCheckpointer(path.join(temporary, 'checkpoints', id)) });
  service.getGraph = async () => compiled;
  return { graph: compiled, observed: () => observed };
}

function post(route, payload) { return app.inject({ method: 'POST', url: `/api/v1/agent/${route}`, payload }); }

test.each(['zh', 'en'])('HTTP %s input reaches attachment parser and saved file/locale/excitation context', async locale => {
  const id = `file-${locale}`;
  const fixture = graphFor(id);
  const relPath = `.uploads/${id}/appendix.csv`;
  fs.mkdirSync(path.dirname(path.join(temporary, relPath)), { recursive: true });
  fs.writeFileSync(path.join(temporary, relPath), 'node,x\nA,6\nB,7\n');
  const seismicWorkflow = { method: 'response_spectrum', direction: 'X' };
  const response = await post('run', { conversationId: id, message: 'Read the attached table', context: {
    locale, attachments: [{ fileId: 'appendix', originalName: 'appendix.csv', relPath, mimeType: 'text/csv' }],
    restrictFileAccessToAttachments: true, seismicWorkflow, runPolicy: { skillIds: ['generic'], tools: { enabledIds: [] } },
  } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ waitingForReply: false, question: null, options: [], runUsage: { llmCalls: 0 } });
  const state = fixture.observed();
  expect(state.locale).toBe(locale);
  expect(state.toolAccessPolicy.fileAccessAllowlist).toEqual([relPath]);
  expect(state.contextSeismicWorkflow).toEqual(seismicWorkflow);
  expect(state.messages[0].content).toContain(locale === 'zh' ? '[附件解析: appendix.csv]' : '[Attachment analysis: appendix.csv]');
  expect(state.messages[0].content).toContain('"A"');
  expect(state.messages[0].content).toContain('"6"');
  expect(state.inputEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: expect.objectContaining({ file: relPath, parser: 'csv-parse' }) })]));
});

test.each(['zh', 'en'])('HTTP %s clarification resumes once with saved policy, counters and reviewed supplement', async locale => {
  const id = `reply-${locale}`;
  const fixture = graphFor(id, { ask: true, chargeBeforePause: true });
  const initial = await post('run', { conversationId: id, message: 'Model a beam', context: { locale,
    restrictFileAccessToAttachments: true, runPolicy: { skillIds: ['generic'],
      tools: { enabledIds: ['ask_user_clarification', 'analyze_file'] }, budgets: { maxToolCallsPerTurn: 5 } },
  } });
  expect(initial.statusCode).toBe(200);
  const waiting = initial.json();
  expect(waiting).toMatchObject({ waitingForReply: true, question: locale === 'zh' ? '支座是什么？' : 'Which support?', options: ['Pinned', 'Fixed'],
    runUsage: { toolCalls: 1, llmCalls: 1, recoveries: 1 } });
  const ledger = path.join(temporary, 'run-records', `${waiting.runUsage.runId}.json`);
  const before = fs.readFileSync(ledger, 'utf8');
  expect((await post('run', { conversationId: id, message: 'Replace the pending turn' })).statusCode).toBe(409);
  expect((await post('resume', { conversationId: id, resumeValue: 'Pinned', context: { runPolicy: { repair: { enabled: false } } } })).statusCode).toBe(400);
  expect((await post('resume', { conversationId: id, resumeValue: 'Pinned', attachments: [] })).statusCode).toBe(400);
  expect(fs.readFileSync(ledger, 'utf8')).toBe(before);

  // Supplemental files use the same review transaction as Web, not a new resume context.
  const relPath = `.uploads/${id}/support.csv`;
  fs.mkdirSync(path.dirname(path.join(temporary, relPath)), { recursive: true });
  fs.writeFileSync(path.join(temporary, relPath), 'node,support\nA,pinned\n');
  const review = await service.getInputReview(id);
  const updated = await service.invokeInputReviewTool(id, { revisionToken: review.revisionToken, tool: 'analyze_file',
    args: { filePath: relPath, mode: 'full' }, initialContext: {
      attachments: [{ fileId: 'support', originalName: 'support.csv', relPath, mimeType: 'text/csv' }],
    } });
  expect(updated.success).toBe(true);
  expect(updated.review.waitingForReply).toBe(true);
  const resumed = await post('resume', { conversationId: id, resumeValue: 'Pinned at A' });
  expect(resumed.statusCode).toBe(200);
  const result = resumed.json();
  expect(result).toMatchObject({ waitingForReply: false, question: null, options: [], runPolicy: { policyHash: waiting.runPolicy.policyHash },
    runUsage: { runId: waiting.runUsage.runId, toolCalls: 2, llmCalls: 1, recoveries: 1 } });
  expect(result.response).toContain('Pinned at A');
  expect(fixture.observed().locale).toBe(locale);
  expect(fixture.observed().inputEvidence.some(item => item.source?.file === relPath)).toBe(true);
  expect(fixture.observed().toolAccessPolicy.fileAccessAllowlist).toEqual([relPath]);
  const finalLedger = fs.readFileSync(ledger, 'utf8');
  expect((await post('resume', { conversationId: id, resumeValue: 'Duplicate' })).statusCode).toBe(409);
  expect((await post('resume', { conversationId: 'unknown', resumeValue: 'Wrong conversation' })).statusCode).toBe(409);
  expect(fs.readFileSync(ledger, 'utf8')).toBe(finalLedger);
});

test('JSON resume surfaces a graph failure without pretending the consumed error stream succeeded', async () => {
  graphFor('resume-failure', { ask: true, failAfterResume: true });
  await post('run', { conversationId: 'resume-failure', message: 'Ask', context: { runPolicy: {
    skillIds: ['generic'], tools: { enabledIds: ['ask_user_clarification'] },
  } } });
  const response = await post('resume', { conversationId: 'resume-failure', resumeValue: 'Pinned' });
  expect(response.statusCode).toBe(500);
  expect(response.json().message).toContain('FIXTURE_RESUME_FAILURE');
});
