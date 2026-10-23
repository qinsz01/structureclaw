import { expect, test } from '@jest/globals';
import { buildAnalysisToolSummary } from '../../../dist/agent-langgraph/tools.js';

test('a multi-case failure retains the precise cause and archive identity seen by the agent', () => {
  const summary = buildAnalysisToolSummary({ skillId: 'pkpm-static', result: {
    success: false, error_code: 'RESULT_SET_INCOMPLETE', message: 'One or more requested results failed; inspect results by key.',
    runId: 'bound-run', selectedResultKey: 'case:D', executionStatus: 'incomplete', results: {
      'case:D': { success: true },
      'case:L': { success: false, error_code: 'PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED', message: 'materials.M.G is inconsistent / 剪切模量不一致',
        meta: { engineId: 'builtin-pkpm', failureKind: 'capability-boundary', capability: 'native-material-properties', detail: { inputFields: ['materials.M.G'] } } },
    },
  } });
  expect(summary).toMatchObject({ success: false, errorCode: 'RESULT_SET_INCOMPLETE', runId: 'bound-run',
    resultKeys: ['case:D', 'case:L'], failedResultCount: 1, failedResults: [{ resultKey: 'case:L',
      errorCode: 'PKPM_NATIVE_MATERIAL_PROPERTIES_UNVERIFIED', message: 'materials.M.G is inconsistent / 剪切模量不一致',
      diagnostics: { capability: 'native-material-properties', inputFields: ['materials.M.G'] } }] });
});

test('failure receipts bound large result sets and never include successful native payloads', () => {
  const results = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`case:${i}`, { success: false, error_code: 'ENGINE_INPUT_UNSUPPORTED',
    message: 'unsupported', data: { privateNativePayload: 'not needed in an agent receipt' } }]));
  const summary = buildAnalysisToolSummary({ result: { success: false, results } });
  expect(summary.failedResultCount).toBe(30);
  expect(summary.failedResults).toHaveLength(20);
  expect(JSON.stringify(summary)).not.toContain('privateNativePayload');
});
