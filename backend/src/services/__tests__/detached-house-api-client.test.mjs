import { describe, expect, test } from '@jest/globals';
import { DetachedHouseApiClient } from '../../../dist/services/detached-house-api-client.js';

describe('DetachedHouseApiClient', () => {
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

  test('throws a useful error for non-JSON API failures', async () => {
    const client = new DetachedHouseApiClient({
      baseUrl: 'http://api.local',
      fetchImpl: async () => new Response('Internal Server Error', { status: 500 }),
    });

    await expect(client.runTool('generate_floor_rooms', { design: {}, options: {} }))
      .rejects.toThrow('Detached-house API generate_floor_rooms failed with HTTP 500');
  });
});
