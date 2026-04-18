import { describe, expect, test } from '@jest/globals';
import {
  AnalysisExecutionService,
  createLocalAnalysisEngineClient,
} from '../dist/services/analysis-execution.js';
import {
  StructureProtocolExecutionService,
  createLocalStructureProtocolClient,
} from '../dist/services/structure-protocol-execution.js';
import { CodeCheckExecutionService, createLocalCodeCheckClient } from '../dist/services/code-check-execution.js';

describe('AnalysisExecutionService and local client', () => {
  test('should map service calls to worker actions', async () => {
    const calls = [];
    const fakeRunner = {
      invoke: async (payload) => {
        calls.push(payload);
        switch (payload.action) {
          case 'list_engines':
          return { engines: [{ id: 'builtin-opensees' }], defaultSelectionMode: 'auto' };
          case 'get_engine':
            return { id: payload.engineId };
          case 'check_engine':
            return { engine: { id: payload.engineId } };
          case 'analyze':
            return { ok: payload.action, input: payload.input };
          default:
            return {};
        }
      },
    };

    const service = new AnalysisExecutionService(fakeRunner);
    await service.listEngines();
    await service.getEngine('builtin-opensees');
    await service.checkEngine('builtin-opensees');
    await service.analyze({ type: 'static', model: {}, parameters: {} });

    expect(calls.map((item) => item.action)).toEqual([
      'list_engines',
      'get_engine',
      'check_engine',
      'analyze',
    ]);
  });

  test('should expose analysis local client paths', async () => {
    const calls = [];
    const fakeRunner = {
      invoke: async (payload, options) => {
        calls.push({ payload, options });
        if (payload.action === 'get_engine') {
          return { id: payload.engineId };
        }
        if (payload.action === 'check_engine') {
          return { checked: payload.engineId };
        }
        return { action: payload.action, input: payload.input };
      },
    };

    const client = createLocalAnalysisEngineClient(new AnalysisExecutionService(fakeRunner));
    expect((await client.get('/engines/builtin-opensees')).data.id).toBe('builtin-opensees');
    expect((await client.post('/engines/builtin-opensees/check')).data.checked).toBe('builtin-opensees');
    expect((await client.post('/analyze', { type: 'static' })).data.action).toBe('analyze');
    expect(calls.map((item) => item.payload.action)).toEqual(['get_engine', 'check_engine', 'analyze']);
  });

  test('should forward AbortSignal through local execution clients', async () => {
    const controller = new AbortController();
    const calls = [];
    const fakeRunner = {
      invoke: async (payload, options) => {
        calls.push({ payload, options });
        return { action: payload.action, input: payload.input };
      },
    };

    const analysisClient = createLocalAnalysisEngineClient(new AnalysisExecutionService(fakeRunner));
    await analysisClient.post('/analyze', { type: 'static' }, { signal: controller.signal });

    const structureService = new StructureProtocolExecutionService();
    structureService.runner = fakeRunner;
    const structureClient = createLocalStructureProtocolClient(structureService);
    await structureClient.post('/validate', { model: {} }, { signal: controller.signal });

    const codeCheckService = new CodeCheckExecutionService();
    codeCheckService.runner = fakeRunner;
    const codeCheckClient = createLocalCodeCheckClient(codeCheckService);
    await codeCheckClient.post('/code-check', { model_id: 'm1', code: 'GB50017', elements: [] }, { signal: controller.signal });

    expect(calls).toHaveLength(3);
    expect(calls.every((item) => item.options?.signal === controller.signal)).toBe(true);
  });

  test('should expose structure protocol service and local client paths', async () => {
    const calls = [];
    const fakeRunner = {
      invoke: async (payload) => {
        calls.push(payload);
        return { action: payload.action, input: payload.input };
      },
    };

    const service = new StructureProtocolExecutionService();
    service.runner = fakeRunner;
    await service.getStructureModelSchema();
    await service.getConverterSchema();
    await service.validate({ model: {} });
    await service.convert({ model: {} });

    expect(calls.map((item) => item.action)).toEqual([
      'structure_model_schema',
      'converter_schema',
      'validate',
      'convert',
    ]);

    const client = createLocalStructureProtocolClient(service);
    expect((await client.get('/schema/converters')).data.action).toBe('converter_schema');
    expect((await client.post('/validate', { model: {} })).data.action).toBe('validate');
    expect((await client.post('/convert', { model: {} })).data.action).toBe('convert');
  });

  test('should expose code-check service and local client path', async () => {
    const calls = [];
    const fakeRunner = {
      invoke: async (payload) => {
        calls.push(payload);
        return { action: payload.action, input: payload.input };
      },
    };

    const service = new CodeCheckExecutionService();
    service.runner = fakeRunner;
    await service.codeCheck({ model_id: 'm1', code: 'GB50017', elements: [] });
    expect(calls.map((item) => item.action)).toEqual(['code_check']);

    const client = createLocalCodeCheckClient(service);
    expect((await client.post('/code-check', { model_id: 'm1', code: 'GB50017', elements: [] })).data.action).toBe('code_check');
  });
});
