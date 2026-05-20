export interface DetachedHouseToolRequest {
  design: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface DetachedHouseToolResponse {
  design: Record<string, unknown>;
  issues: Array<Record<string, unknown>>;
}

export type DetachedHouseFetch = typeof fetch;

export class DetachedHouseApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: DetachedHouseFetch;
  private readonly timeoutMs: number;

  constructor(args: { baseUrl: string; fetchImpl?: DetachedHouseFetch; timeoutMs?: number }) {
    this.baseUrl = args.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = args.fetchImpl ?? fetch;
    this.timeoutMs = args.timeoutMs ?? 1800000;
  }

  async runTool(toolId: string, request: DetachedHouseToolRequest): Promise<DetachedHouseToolResponse> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    const endpoint = `${this.baseUrl}/tools/${toolId}`;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          design: request.design,
          options: request.options ?? {},
        }),
        signal: abortController.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Detached-house API ${toolId} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Detached-house API ${toolId} returned non-JSON response: ${text.slice(0, 500)}`);
      }
      return normalizeDetachedHouseToolResponse(toolId, payload);
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new Error(`Detached-house API ${toolId} timed out after ${this.timeoutMs}ms`);
      }
      if (isRequestTransportError(error)) {
        throw new Error(formatRequestTransportError(toolId, endpoint, error));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeDetachedHouseToolResponse(toolId: string, payload: unknown): DetachedHouseToolResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Detached-house API ${toolId} returned invalid response object`);
  }
  const record = payload as Record<string, unknown>;
  if (!record.design || typeof record.design !== 'object' || Array.isArray(record.design)) {
    throw new Error(`Detached-house API ${toolId} response is missing design`);
  }
  return {
    design: record.design as Record<string, unknown>,
    issues: Array.isArray(record.issues) ? record.issues.filter(isRecord) : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }
  return error instanceof TypeError || error.name === 'AbortError' || Boolean((error as { cause?: unknown }).cause);
}

function formatRequestTransportError(toolId: string, endpoint: string, error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? formatErrorCause((error as { cause?: unknown }).cause) : null;
  const causeText = cause ? ` (cause: ${cause})` : '';
  return `Detached-house API ${toolId} request failed at ${endpoint}: ${errorMessage}${causeText}`;
}

function formatErrorCause(cause: unknown): string | null {
  if (!cause) {
    return null;
  }
  if (isRecord(cause)) {
    const code = typeof cause.code === 'string' ? cause.code : null;
    const address = typeof cause.address === 'string' ? cause.address : null;
    const port = typeof cause.port === 'number' || typeof cause.port === 'string' ? String(cause.port) : null;
    if (code && address && port) {
      return `${code} ${address}:${port}`;
    }
    const compact = [code, address, port].filter(Boolean).join(' ');
    if (compact) {
      return compact;
    }
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
