/** Read-only chat projections. Complete solver data and provenance stay in the run archive. */
import { withoutPlaceholderDisplacements } from '../engineering/stiffness-placeholder.js';
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const NATIVE_AUDIT_FIELDS = new Set([
  'pkpm_detailed', 'nativeContext', 'reactionSource', 'reactionObjectSources',
  'boundaryDisplacementSource', 'modelProjection', 'nativeDesignContext',
]);

function projectData(data: RecordValue, runId: string, resultKey: string | undefined, resultKeys: Set<string>): RecordValue {
  const projected = Object.fromEntries(Object.entries(data).filter(([key]) => !NATIVE_AUDIT_FIELDS.has(key)));
  if (Array.isArray(data.memberResponses)) {
    // Native station readback is already represented by the canonical member samples. Every
    // sample and numeric component is kept; only its repeated source document becomes a locator.
    const represented = new Set(data.memberResponses.filter(member => record(member) && Array.isArray(member.samples) && member.samples.length)
      .map(member => (member as RecordValue).id));
    if (record(data.memberStations) && Object.keys(data.memberStations).every(id => represented.has(id))) delete projected.memberStations;
    projected.memberResponses = data.memberResponses.map(member => record(member) && Array.isArray(member.samples)
      ? { ...member, samples: member.samples.map((sample: unknown, sampleIndex: number) => record(sample) && sample.source !== undefined
        ? { ...sample, source: { kind: 'run-member-sample', runId, resultKey, memberId: member.id, sampleIndex } } : sample) } : member);
  }
  if (record(data.caseResults)) {
    const cases = Object.keys(data.caseResults);
    if (cases.length && cases.every(id => resultKeys.has(`case:${id}`))) {
      // Explicit independent result sets are authoritative; never send the legacy aggregate
      // copies as another set of results or as a fallback for an unavailable child.
      delete projected.caseResults;
    } else {
      projected.caseResults = Object.fromEntries(Object.entries(data.caseResults)
        .map(([key, value]) => [key, record(value) ? projectData(value, runId, resultKey, new Set()) : value]));
    }
  }
  return projected;
}

export function projectAnalysisForChat(value: unknown): unknown {
  if (!record(value) || typeof value.runId !== 'string' || !value.runId) return value;
  const runId = value.runId;
  const source = withoutPlaceholderDisplacements(value);
  const results = record(source.results) ? source.results : undefined;
  const keys = new Set(Object.keys(results ?? {}));
  const selectedKey = typeof source.selectedResultKey === 'string' ? source.selectedResultKey : undefined;
  const projectResult = (result: RecordValue, key: string | undefined): RecordValue => ({ ...result,
    ...(record(result.data) ? { data: projectData(result.data, runId, key, keys) } : {}) });
  const projected = projectResult(source, selectedKey);
  if (results) projected.results = Object.fromEntries(Object.entries(results).map(([key, result]) => [key,
    record(result) ? projectResult(result, key) : result]));
  if (selectedKey && results && record(results[selectedKey]) && record(results[selectedKey].data)) {
    delete projected.data; // The selected payload is already at results[selectedResultKey].data.
    projected.selectedDataReference = { resultKey: selectedKey };
  }
  projected.artifactReference = { kind: 'analysis-run', runId };
  return projected;
}

export function projectReportForChat(value: unknown): unknown {
  if (!record(value) || !record(value.json) || !record(value.json.analysis)) return value;
  const analysis = value.json.analysis;
  if (typeof analysis.runId !== 'string' || !analysis.runId) return value;
  const { analysis: _analysis, ...json } = value.json;
  return { ...value, json: { ...json, analysisReference: { kind: 'analysis-run', runId: analysis.runId,
    selectedResultKey: analysis.selectedResultKey, resultKeys: record(analysis.results) ? Object.keys(analysis.results) : [] } } };
}

export function projectChatResult<T>(value: T): T {
  if (!record(value)) return value;
  return { ...value,
    ...(value.analysis !== undefined ? { analysis: projectAnalysisForChat(value.analysis) } : {}),
    ...(value.report !== undefined ? { report: projectReportForChat(value.report) } : {}),
  } as T;
}

export function projectChatStreamChunk(value: unknown): unknown {
  if (!record(value)) return value;
  if (value.type === 'result') return { ...value, content: projectChatResult(value.content) };
  if (value.type === 'artifact_payload_sync') return { ...value, latestResult: projectChatResult(value.latestResult) };
  return value;
}

/** One connection's artifacts are sent once, then referenced by the final result. Identity
 * comparison is deliberate: a changed artifact must never be deduplicated by run id alone. */
export function createChatStreamProjection(): (value: unknown) => unknown {
  const artifacts = new Map<string, { id: string; raw: unknown }>();
  let sequence = 0;
  return value => {
    if (!record(value)) return value;
    if (value.type === 'artifact_payload_sync' && typeof value.artifact === 'string') {
      const kind = value.artifact;
      if (value.invalidated) {
        artifacts.delete(kind);
        if (kind === 'analysis') artifacts.delete('report');
        return projectChatStreamChunk(value);
      }
      const raw = kind === 'model' ? value.model : record(value.latestResult) ? value.latestResult[kind] : undefined;
      if (record(raw) && ['model', 'analysis', 'report'].includes(kind)) {
        const id = `${kind}:${++sequence}`;
        artifacts.set(kind, { id, raw });
        return { ...(projectChatStreamChunk(value) as RecordValue), artifactId: id };
      }
    }
    if (value.type === 'result' && record(value.content)) {
      const content = { ...value.content }, references: Record<string, string> = {};
      for (const [kind, artifact] of artifacts) {
        if (content[kind] !== artifact.raw) continue;
        delete content[kind];references[kind] = artifact.id;
      }
      artifacts.clear();
      return projectChatStreamChunk({ ...value, content: { ...content,
        ...(Object.keys(references).length ? { artifactReferences: references } : {}) } });
    }
    return projectChatStreamChunk(value);
  };
}
