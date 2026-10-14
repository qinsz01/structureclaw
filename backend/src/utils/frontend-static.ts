import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { existsSync } from 'node:fs';

export async function registerFrontendStatic(fastify: FastifyInstance, frontendDir: string): Promise<void> {
  await fastify.register(fastifyStatic, {
    root: frontendDir,
    prefix: '/',
    // Resolve files at request time: a rebuilt export has different chunk names.
    wildcard: true,
  });

  fastify.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0];
    if (!['GET', 'HEAD'].includes(request.method)
      || /^\/(?:api|docs)(?:\/|$)/u.test(pathname)
      || pathname.startsWith('/_next/')
      || path.extname(pathname)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const routePath = pathname.replace(/^\/+|\/+$/gu, '');
    const htmlFile = routePath ? `${routePath}.html` : 'index.html';
    const relative = path.relative(frontendDir, path.resolve(frontendDir, htmlFile));
    if (!relative.startsWith('..') && !path.isAbsolute(relative)
      && existsSync(path.join(frontendDir, htmlFile))) {
      return reply.sendFile(htmlFile);
    }
    if (existsSync(path.join(frontendDir, '404.html'))) return reply.code(404).sendFile('404.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}
