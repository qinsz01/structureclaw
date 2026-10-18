import { currentAnalysisError, isRecord, modelHash, type ModelRecord, type ModelState } from './model-state.js';
import { nativeDesignRecord } from './native-design.js';
import { resultEngine } from './result-data.js';
import { stiffnessPlaceholderOf } from './stiffness-placeholder.js';

type Label = { zh: string; en: string };
type Parameter = { key: string; label: Label; kind: 'integer' | 'choice' | 'boolean'; min?: number; max?: number; choices?: string[]; unit?: string };
const label = (zh: string, en: string): Label => ({ zh, en });

/** UI descriptions only. The engine's native compiler and readback remain authoritative. */
export function nativeDesignOptions(engine: string, model: ModelRecord | null | undefined) {
  if (!['pkpm', 'yjk'].includes(engine)) return null;
  const families = new Set(Array.isArray(model?.materials) ? model.materials.filter(isRecord).map(row => row.category ?? row.type) : []);
  const concrete = families.size === 1 && families.has('concrete');
  const steel = families.size === 1 && families.has('steel');
  const codes = engine === 'pkpm' ? ['PKPM-2025R2.5-native', ...(steel ? ['GB50017-2017'] : [])]
    : steel ? ['GB50017-2017'] : concrete ? ['GB/T50010-2010(2024)'] : [];
  const parameters: Parameter[] = [];
  if (concrete) {
    for (const [role, title] of [['beam', label('梁', 'Beam')], ['column', label('柱', 'Column')]] as const) {
      parameters.push({ key: `${role}CoverMm`, label: label(`${title.zh}保护层`, `${title.en} cover`), kind: 'integer', min: 10, max: 100, unit: 'mm' },
        { key: `${role}StirrupSpacingMm`, label: label(`${title.zh}原生设计箍筋间距`, `${title.en} native design stirrup spacing`),
          kind: 'integer', min: engine === 'pkpm' ? 100 : 25, max: engine === 'pkpm' ? 100 : 500, unit: 'mm' },
        { key: `${role}MainRebarGrade`, label: label(`${title.zh}纵筋牌号`, `${title.en} main rebar grade`), kind: 'choice', choices: ['HRB400', 'HRB500'] });
      if (engine === 'pkpm') parameters.push({ key: `${role}StirrupGrade`, label: label(`${title.zh}箍筋牌号`, `${title.en} stirrup grade`),
        kind: 'choice', choices: ['HPB235', 'HRB335', 'HRB400', 'HPB300', 'HRB500'] });
    }
  }
  if (steel && engine === 'yjk') for (const axis of ['X', 'Y']) parameters.push({ key: `steelColumnSway${axis}`, kind: 'boolean',
    label: label(`钢柱 ${axis} 向有侧移计算长度方法`, `Steel column ${axis} sway effective-length method`) });
  return { engine, codes, modes: ['code-check', ...(concrete ? ['required-reinforcement'] : [])], parameters,
    descriptionScope: 'request-options-not-native-acceptance', defaults: 'explicit-adoption-and-native-readback',
    combinationScope: 'software-automatic-design-combinations' };
}

/** Rebuild a saved design record only from an explicitly requested, model-bound native run. */
export function savedNativeDesignRecord(run: ModelRecord): ModelRecord | null {
  const model = isRecord(run.modelSnapshot) ? run.modelSnapshot : undefined;
  const data = isRecord(run.data) ? run.data : {};
  const context = isRecord(data.nativeDesignContext) ? data.nativeDesignContext : {};
  const meta = isRecord(run.meta) ? run.meta : {};
  const parameters = isRecord(meta.requestParameters) ? meta.requestParameters : {};
  const request = isRecord(context.request) ? context.request : isRecord(parameters.design) ? parameters.design : {};
  if (!model || !['yjk', 'pkpm'].includes(resultEngine(run)) || meta.modelHash !== modelHash(model)
    || request.requested !== true || typeof request.code !== 'string') return null;
  return nativeDesignRecord(model, run, request.code);
}

export function nativeDesignReview(state: ModelState & { analysisRuns?: Record<string, ModelRecord> }, allowed: string[]) {
  const engine = state.analysisResult ? resultEngine(state.analysisResult) : '';
  const options = nativeDesignOptions(engine, state.model);
  const hash = state.model ? modelHash(state.model) : undefined;
  const runs = { ...state.analysisRuns };
  if (typeof state.analysisResult?.runId === 'string') runs[state.analysisResult.runId] = state.analysisResult;
  const attempts = Object.values(runs).filter(run => isRecord(run.meta) && run.meta.modelHash === hash
    && run.meta.modelRevision === (state.modelRevision ?? 0) && resultEngine(run) === engine)
    .sort((a, b) => Number((isRecord(a.meta) ? a.meta : {}).requestSequence ?? 0) - Number((isRecord(b.meta) ? b.meta : {}).requestSequence ?? 0))
    .map(run => {
      const record = savedNativeDesignRecord(run);
      if (!record) return null;
      const context = isRecord(record.nativeDesignContext) ? record.nativeDesignContext : {};
      const meta = isRecord(run.meta) ? run.meta : {};
      const parameters = isRecord(meta.requestParameters) ? meta.requestParameters : {};
      // Omit opaque SDK arrays; report export retains their archived source.
      const { nativeDesignResults: _raw, nativeDesignContext: _context, ...display } = record;
      return { ...display, requested: context.request ?? parameters.design, effectiveCodeProfile: context.effectiveCodeProfile,
        effectiveParameters: context.effectiveParameters, effectiveMemberInputs: context.effectiveMemberInputs,
        artifacts: context.artifacts, current: run.runId === state.analysisResult?.runId && !currentAnalysisError(state) } as ModelRecord;
    }).filter((row): row is NonNullable<typeof row> => row !== null);
  // A unit-stiffness placeholder model has no real material or section to design.
  const placeholder = stiffnessPlaceholderOf(state.model) ?? stiffnessPlaceholderOf(state.analysisResult);
  const reason = placeholder ? 'STIFFNESS_PLACEHOLDER_MODEL' : !options ? 'NATIVE_DESIGN_ENGINE_REQUIRED' : currentAnalysisError(state)
    ?? (!allowed.includes('run_code_check') ? 'TOOL_NOT_ALLOWED' : !options.codes.length ? 'ENGINE_INPUT_UNSUPPORTED' : null);
  return { modelRevision: state.modelRevision ?? 0, modelHash: hash ?? null, runId: state.analysisResult?.runId ?? null,
    options, available: reason === null, reason, latestAttempt: attempts.at(-1) ?? null,
    acceptedRecords: attempts.filter(row => row.completionStatus === 'complete') };
}
