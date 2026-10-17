import type { z } from 'zod';

/**
 * Parse a request body/query with its Zod schema. A schema-invalid request is a client error:
 * the thrown error carries statusCode 400, so Fastify answers 400 with its usual
 * `{ statusCode, error, message }` body and the unchanged (bilingual where defined) issue message.
 */
export function parseRequest<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw Object.assign(new Error(parsed.error.message, { cause: parsed.error }), { statusCode: 400 });
}
