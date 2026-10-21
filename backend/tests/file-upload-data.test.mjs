import { afterAll, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sclaw-data-upload-'));
process.env.SCLAW_DATA_DIR = directory;
const { fileRoutes } = await import('../dist/api/files.js');
const app = Fastify();
await app.register(multipart);
await app.register(fileRoutes);
afterAll(async () => {
  await app.close();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('sclaw-data-upload-')) throw new Error('Invalid fixture directory');
  await fs.rm(directory, { recursive: true, force: true });
});

test.each([
  ['properties.json', 'application/json', '{"A":0.01}'],
  ['properties.tsv', 'text/tab-separated-values', 'section\tA\nS\t0.01'],
])('uploads %s through the normal multipart endpoint', async (name, mime, content) => {
  const boundary = 'sclaw-upload-test';
  const response = await app.inject({ method: 'POST', url: '/upload?conversationId=data-test',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  });
  expect(response.statusCode).toBe(200);
  const result = response.json();
  expect(result.success).toBe(true);
  expect(await fs.readFile(path.join(directory, result.files[0].relPath), 'utf8')).toBe(content);
});
