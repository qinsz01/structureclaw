import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/index.js';
import { isLlmTimeoutError, isContextOverflowError, toLlmStreamError } from '../utils/llm-error.js';

function setSseCorsHeaders(request: FastifyRequest, reply: FastifyReply) {
  const origin = request.headers.origin;

  if (!origin) {
    return;
  }

  if (!config.corsOrigins.includes(origin)) {
    return;
  }

  reply.raw.setHeader('Access-Control-Allow-Origin', origin);
  reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
  reply.raw.setHeader('Vary', 'Origin');
}

function normalizePublicStreamChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object') {
    return chunk;
  }

  const raw = chunk as { type?: string; error?: string; code?: string; retriable?: boolean; content?: unknown };
  const value = raw.type && raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content)
    ? raw
    : raw;

  if (value.type !== 'error' || !value.error) {
    return value;
  }

  if (isLlmTimeoutError(value.error)) {
    return {
      ...value,
      code: 'LLM_TIMEOUT',
      retriable: true,
    };
  }

  if (isContextOverflowError(value.error)) {
    return {
      ...value,
      code: 'CONTEXT_OVERFLOW',
      retriable: false,
    };
  }

  return {
    ...value,
    code: value.code || 'INTERNAL_ERROR',
    retriable: value.retriable ?? false,
  };
}

/** Writer handed to an SSE turn while the agent stream is being relayed. */
export interface SseTurnSession {
  /** Aborted when the client disconnects (response or socket closed). */
  signal: AbortSignal;
  /** Writes an agent stream chunk in its public (error-normalized) form. */
  writeChunk(chunk: unknown): void;
  /** Writes a pre-built public event verbatim. */
  writeEvent(event: unknown): void;
}

export interface SseTurnHandlers {
  /** Route path used in the unexpected-error log line. */
  route: string;
  /** Log message when the client aborted the stream. */
  abortedMessage: string;
  /** Conversation id logged with the abort message. */
  conversationId(): string | undefined;
  /** Relays the agent stream; must stop when `session.signal` is aborted. */
  relay(session: SseTurnSession): Promise<void>;
  /** Persists the turn; idempotent, called after relay, on failure and in `finally`. */
  persist(aborted: boolean): Promise<void>;
  /** Records the public failure message on the turn before it is persisted. */
  onFailure(message: string): void;
  /** Log message when persisting after a failure throws. */
  interruptedPersistMessage: string;
  /** Handles an error from the final `finally` persistence attempt. */
  onFinalPersistError(error: unknown): void;
}

/**
 * Shared SSE lifecycle for /stream and /stream/resume: hijack the reply, set SSE/CORS
 * headers, abort on client disconnect, relay chunks, persist, and terminate with [DONE].
 */
export async function runSseTurn(request: FastifyRequest, reply: FastifyReply, handlers: SseTurnHandlers): Promise<void> {
  reply.hijack();
  setSseCorsHeaders(request, reply);
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders?.();

  const abortController = new AbortController();
  const onClose = () => { abortController.abort(); };
  // Listen on both reply.raw and request.socket to reliably detect
  // client disconnect. reply.raw 'close' may not fire on all Node.js
  // versions; request.socket 'close' fires when the TCP socket closes.
  reply.raw.on('close', onClose);
  request.socket.on('close', onClose);

  const writeEvent = (event: unknown) => { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); };
  const session: SseTurnSession = {
    signal: abortController.signal,
    writeChunk: (chunk) => writeEvent(normalizePublicStreamChunk(chunk)),
    writeEvent,
  };

  try {
    await handlers.relay(session);

    // Save user + assistant messages to DB so the next request has context.
    // This runs for both completed and aborted streams.
    await handlers.persist(abortController.signal.aborted);

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      request.log.info({ conversationId: handlers.conversationId() }, handlers.abortedMessage);
      reply.raw.end();
    } else {
      request.log.error({ err: error }, `Unexpected error in ${handlers.route}`);
      const failure = toLlmStreamError(error);
      handlers.onFailure(failure.error);
      await handlers.persist(false).catch(persistError => request.log.error({ err: persistError }, handlers.interruptedPersistMessage));
      reply.raw.write(`data: ${JSON.stringify(failure)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }
  } finally {
    // Ensure messages are persisted even on unexpected errors.
    await handlers.persist(abortController.signal.aborted).catch(handlers.onFinalPersistError);
    reply.raw.off('close', onClose);
    request.socket.off('close', onClose);
  }
}
