export interface DetachedHouseToolRequest {
  design: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface DetachedHouseToolResponse {
  design: Record<string, unknown>;
  issues: Array<Record<string, unknown>>;
}

export type DetachedHouseFetch = typeof fetch;

const DETACHED_HOUSE_SERVICE_UNAVAILABLE_MESSAGE =
  'Detached-house design service is temporarily unavailable while service integration is being connected. 独立住宅设计服务暂时无法使用，后续会接通。';

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
        throw createDetachedHouseServiceUnavailableError();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw createDetachedHouseServiceUnavailableError();
      }
      return normalizeDetachedHouseToolResponse(toolId, payload);
    } catch (error) {
      if (isDetachedHouseServiceUnavailableError(error)) {
        throw error;
      }
      if (abortController.signal.aborted) {
        throw createDetachedHouseServiceUnavailableError();
      }
      if (isRequestTransportError(error)) {
        throw createDetachedHouseServiceUnavailableError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeDetachedHouseToolResponse(toolId: string, payload: unknown): DetachedHouseToolResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createDetachedHouseServiceUnavailableError();
  }
  const record = payload as Record<string, unknown>;
  if (!record.design || typeof record.design !== 'object' || Array.isArray(record.design)) {
    throw createDetachedHouseServiceUnavailableError();
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

function isDetachedHouseServiceUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === DETACHED_HOUSE_SERVICE_UNAVAILABLE_MESSAGE;
}

function createDetachedHouseServiceUnavailableError(): Error {
  return new Error(DETACHED_HOUSE_SERVICE_UNAVAILABLE_MESSAGE);
}
