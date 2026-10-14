import { describe, expect, test } from '@jest/globals';

describe('analysis runtime routes', () => {
  test('should expose backend analysis runtime endpoints from root', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(process.cwd() + '/backend/package.json');
    const Fastify = require('fastify');

    const { AnalysisExecutionService } = await import('../dist/services/analysis-execution.js');
    const { StructureProtocolExecutionService } = await import('../dist/services/structure-protocol-execution.js');
    const { AnalysisService } = await import('../dist/services/analysis.js');
    StructureProtocolExecutionService.prototype.getStructureModelSchema = async function mockStructureSchema() {
      return { title: 'StructureModelV1' };
    };
    StructureProtocolExecutionService.prototype.getConverterSchema = async function mockConverterSchema() {
      return { supportedFormats: ['structuremodel-v1'] };
    };
    AnalysisExecutionService.prototype.listEngines = async function mockListEngines() {
      return { engines: [{ id: 'builtin-opensees' }], defaultSelectionMode: 'auto' };
    };
    AnalysisExecutionService.prototype.getEngine = async function mockGetEngine(id) {
      return id === 'builtin-opensees' ? { id } : null;
    };
    AnalysisExecutionService.prototype.checkEngine = async function mockCheckEngine(id) {
      return { engine: { id } };
    };
    StructureProtocolExecutionService.prototype.validate = async function mockValidate(body) {
      return { valid: true, echo: body.engineId };
    };
    StructureProtocolExecutionService.prototype.convert = async function mockConvert() {
      return { model: { schema_version: '2.0.0' } };
    };
    AnalysisExecutionService.prototype.analyze = async function mockAnalyze(body) {
      return { success: true, analysis_type: body.type, requestBinding: body.requestBinding };
    };
    AnalysisExecutionService.prototype.recoverRequest = async function mockRecover(id, expectedStateHash) {
      return { requestId: id, expectedStateHash, status: 'completed' };
    };
    AnalysisService.prototype.codeCheck = async function mockCodeCheck(body) {
      return { code: body.code, status: 'success', source: body };
    };

    const { analysisRuntimeRoutes } = await import('../dist/api/analysis-runtime.js');

    const app = Fastify();
    await app.register(analysisRuntimeRoutes);

    expect((await app.inject({ method: 'GET', url: '/schema/structure-model-v1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/schema/converters' })).json().supportedFormats).toContain('structuremodel-v1');
    expect((await app.inject({ method: 'GET', url: '/engines' })).json().engines[0].id).toBe('builtin-opensees');
    expect((await app.inject({ method: 'GET', url: '/engines/builtin-opensees' })).json().id).toBe('builtin-opensees');
    expect((await app.inject({ method: 'POST', url: '/engines/builtin-opensees/check' })).json().engine.id).toBe('builtin-opensees');
    expect((await app.inject({ method: 'POST', url: '/validate', payload: { model: {}, engineId: 'builtin-opensees' } })).json().valid).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/convert', payload: { model: {} } })).json().model.schema_version).toBe('2.0.0');
    expect((await app.inject({ method: 'POST', url: '/analyze', payload: { type: 'static', model: {}, parameters: {} } })).json().success).toBe(true);
    const recoveryUrl = '/analysis-requests/05a02a2c-5ab2-4564-a773-36d84e87c3fa/recover';
    expect((await app.inject({ method: 'POST', url: recoveryUrl, payload: { expectedStateHash: 'a'.repeat(64) } })).json())
      .toMatchObject({ status: 'completed', expectedStateHash: 'a'.repeat(64) });
    expect((await app.inject({ method: 'POST', url: recoveryUrl, payload: {} })).statusCode).not.toBe(200);
    const requestBinding = { modelRevision: 3, modelHash: 'model', settingsHash: 'settings', requestSequence: 5 };
    expect((await app.inject({ method: 'POST', url: '/analyze', payload: { type: 'static', model: {}, requestBinding } })).json().requestBinding).toEqual(requestBinding);
    expect((await app.inject({ method: 'POST', url: '/analyze', payload: { type: 'static', model: {}, requestBinding: { ...requestBinding, requestSequence: -1 } } })).statusCode).not.toBe(200);
    const checked = await app.inject({ method: 'POST', url: '/code-check', payload: {
      model_id: 'm1', analysisId: 'a1', runId: 'r1', code: 'GB50017', elements: [],
    } });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().source).toMatchObject({ modelId: 'm1', analysisId: 'a1', runId: 'r1' });
    expect((await app.inject({ method: 'POST', url: '/code-check', payload: { model_id: 'm1', code: 'GB50017', elements: [] } })).statusCode).not.toBe(200);

    await app.close();
  });
});
