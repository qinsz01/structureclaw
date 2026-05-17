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
    this.timeoutMs = args.timeoutMs ?? 180000;
  }

  async runTool(toolId: string, request: DetachedHouseToolRequest): Promise<DetachedHouseToolResponse> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/tools/${toolId}`, {
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
