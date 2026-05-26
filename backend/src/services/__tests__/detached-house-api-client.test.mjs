import { describe, expect, test } from '@jest/globals';
import { DetachedHouseApiClient } from '../../../dist/services/detached-house-api-client.js';

describe('DetachedHouseApiClient', () => {
  const serviceUnavailableMessage =
    'Detached-house design service is temporarily unavailable while service integration is being connected. 独立住宅设计服务暂时无法使用，后续会接通。';

  test('posts design and options to a detached-house tool endpoint', async () => {
    const calls = [];
    const client = new DetachedHouseApiClient({
      baseUrl: 'http://127.0.0.1:8569/',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ design: { floors: [] }, issues: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const response = await client.runTool('generate_floor_rooms', {
      design: { floors: [{ id: 'F1' }] },
      options: { floor_id: 'F1' },
    });

    expect(response).toEqual({ design: { floors: [] }, issues: [] });
    expect(calls[0].url).toBe('http://127.0.0.1:8569/tools/generate_floor_rooms');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      design: { floors: [{ id: 'F1' }] },
      options: { floor_id: 'F1' },
    });
  });

  test('throws a user-safe error for service HTTP failures', async () => {
    const client = new DetachedHouseApiClient({
      baseUrl: 'http://api.local',
      fetchImpl: async () => new Response('Internal Server Error', { status: 500 }),
    });

    await expect(client.runTool('generate_floor_rooms', { design: {}, options: {} }))
      .rejects.toThrow(serviceUnavailableMessage);
  });

  test('throws a user-safe error when the detached-house design service request times out', async () => {
    const client = new DetachedHouseApiClient({
      baseUrl: 'http://api.local',
      timeoutMs: 1,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      }),
    });

    await expect(client.runTool('generate_column_grid', { design: {}, options: {} }))
      .rejects.toThrow(serviceUnavailableMessage);
  });

  test('hides endpoint and network cause when the detached-house design service request fails before response', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8569'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 8569,
    });
    const fetchError = new TypeError('fetch failed', { cause });
    const client = new DetachedHouseApiClient({
      baseUrl: 'http://127.0.0.1:8569',
      fetchImpl: async () => {
        throw fetchError;
      },
    });

    try {
      await client.runTool('generate_floor_rooms', { design: {}, options: {} });
      throw new Error('Expected request to fail');
    } catch (error) {
      expect(error.message).toBe(serviceUnavailableMessage);
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain('127.0.0.1');
      expect(error.message).not.toContain('/tools/generate_floor_rooms');
      expect(error.message).not.toContain('ECONNREFUSED');
    }
  });
});
