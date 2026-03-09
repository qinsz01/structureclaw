import { describe, expect, test } from '@jest/globals';
import { AgentService } from '../dist/services/agent.js';

describe('AgentService orchestration', () => {
  test('should execute analyze -> code-check -> report closed loop', async () => {
    const svc = new AgentService();
    svc.llm = null;
    svc.engineClient.post = async (path, payload) => {
      if (path === '/validate') {
        return { data: { valid: true, schemaVersion: '1.0.0' } };
      }
      if (path === '/analyze') {
        return {
          data: {
            schema_version: '1.0.0',
            analysis_type: payload.type,
            success: true,
            error_code: null,
            message: 'ok',
            data: {},
            meta: {},
          },
        };
      }
      if (path === '/code-check') {
        return {
          data: {
            code: payload.code,
            status: 'success',
            summary: { total: payload.elements.length, passed: payload.elements.length, failed: 0, warnings: 0 },
            details: [],
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    };

    const result = await svc.run({
      message: '请静力分析并规范校核',
      mode: 'execute',
      context: {
        model: {
          schema_version: '1.0.0',
          nodes: [{ id: '1', x: 0, y: 0, z: 0 }, { id: '2', x: 3, y: 0, z: 0 }],
          elements: [{ id: 'E1', type: 'beam', nodes: ['1', '2'], material: '1', section: '1' }],
          materials: [{ id: '1', name: 'steel', E: 205000, nu: 0.3, rho: 7850 }],
          sections: [{ id: '1', name: 'B1', type: 'beam', properties: { A: 0.01, Iy: 0.0001 } }],
          load_cases: [],
          load_combinations: [],
        },
        autoAnalyze: true,
        autoCodeCheck: true,
        designCode: 'GB50017',
        includeReport: true,
        reportFormat: 'both',
      },
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls.some((c) => c.tool === 'analyze')).toBe(true);
    expect(result.toolCalls.some((c) => c.tool === 'code-check')).toBe(true);
    expect(result.toolCalls.some((c) => c.tool === 'report')).toBe(true);
    expect(result.codeCheck?.code).toBe('GB50017');
    expect(typeof result.report?.markdown).toBe('string');
  });

  test('should fail when code-check fails in closed loop', async () => {
    const svc = new AgentService();
    svc.llm = null;
    svc.engineClient.post = async (path, payload) => {
      if (path === '/validate') {
        return { data: { valid: true, schemaVersion: '1.0.0' } };
      }
      if (path === '/analyze') {
        return {
          data: {
            schema_version: '1.0.0',
            analysis_type: payload.type,
            success: true,
            error_code: null,
            message: 'ok',
            data: {},
            meta: {},
          },
        };
      }
      if (path === '/code-check') {
        const error = new Error('code check failed');
        error.response = { data: { errorCode: 'CODE_CHECK_EXECUTION_FAILED' } };
        throw error;
      }
      throw new Error(`unexpected path ${path}`);
    };

    const result = await svc.run({
      message: '请静力分析并规范校核',
      mode: 'execute',
      context: {
        model: {
          schema_version: '1.0.0',
          nodes: [{ id: '1', x: 0, y: 0, z: 0 }, { id: '2', x: 3, y: 0, z: 0 }],
          elements: [{ id: 'E1', type: 'beam', nodes: ['1', '2'], material: '1', section: '1' }],
          materials: [{ id: '1', name: 'steel', E: 205000, nu: 0.3, rho: 7850 }],
          sections: [{ id: '1', name: 'B1', type: 'beam', properties: { A: 0.01, Iy: 0.0001 } }],
          load_cases: [],
          load_combinations: [],
        },
        autoAnalyze: true,
        autoCodeCheck: true,
        designCode: 'GB50017',
      },
    });

    expect(result.success).toBe(false);
    const codeCheckCall = result.toolCalls.find((c) => c.tool === 'code-check');
    expect(codeCheckCall?.status).toBe('error');
    expect(codeCheckCall?.errorCode).toBe('CODE_CHECK_EXECUTION_FAILED');
  });
});
