import { test, expect } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerFrontendStatic } from '../dist/utils/frontend-static.js';

test('static export routes and RSC files load; missing chunks never masquerade as HTML', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sclaw-static-'));
  const put = (file, content) => { const target = path.join(dir, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); };
  const app = Fastify();
  try {
    put('index.html', '<h1>Home</h1>');
    put('capabilities.html', '<h1>Capabilities</h1>');
    put('capabilities.txt', 'RSC payload');
    put('404.html', '<h1>Unknown page</h1>');
    app.get('/api/example', async () => ({ ok: true }));
    await registerFrontendStatic(app, dir);
    await app.ready();
    for (const url of ['/capabilities', '/capabilities/']) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Capabilities');
    }
    expect((await app.inject({ url: '/capabilities.txt?_rsc=1' })).body).toBe('RSC payload');
    expect((await app.inject({ url: '/api/example' })).json()).toEqual({ ok: true });
    for (const url of ['/_next/static/chunks/missing.js', '/unknown.txt', '/api/missing']) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).not.toContain('text/html');
    }
    const unknown = await app.inject({ url: '/unknown-page' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain('Unknown page');
    put('_next/static/chunks/new-build.js', 'console.log("rebuilt")');
    const rebuilt = await app.inject({ url: '/_next/static/chunks/new-build.js' });
    expect(rebuilt.statusCode).toBe(200);
    expect(rebuilt.headers['content-type']).toContain('javascript');
    expect(rebuilt.body).toContain('rebuilt');
  } finally {
    await app.close();
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sclaw-static-')) throw new Error('Invalid fixture');
    rmSync(dir, { recursive: true, force: true });
  }
});
