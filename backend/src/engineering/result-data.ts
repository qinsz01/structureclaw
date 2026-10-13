import { recoverAnalysisMembers, queryMemberResponse, memberResponseExtrema } from '../agent-skills/result-postprocess/member-response.js';
import type { RecoveryModel, RecoveryResult } from '../skill-shared/member-response.js';
import { isRecord, type ModelRecord } from './model-state.js';

function recoveryModel(model: ModelRecord): model is ModelRecord & RecoveryModel {
  return model.unit_system === 'SI' && isRecord(model.coordinate_system)
    && ['nodes', 'elements', 'materials', 'sections', 'load_cases'].every((key) => Array.isArray(model[key]));
}

export function resultFactors(model: ModelRecord, selection: ModelRecord): Record<string, number> | undefined {
  if (selection.kind === 'case') return { [String(selection.id)]: 1 };
  if (selection.kind === 'combination' && Array.isArray(model.load_combinations)) {
    const combination = model.load_combinations.find((item) => isRecord(item) && item.id === selection.id);
    return isRecord(combination) && isRecord(combination.factors) ? combination.factors as Record<string, number> : undefined;
  }
  return undefined;
}

export function resultEngine(result: ModelRecord): string {
  const meta = isRecord(result.meta) ? result.meta : {};
  return String(meta.engineId ?? '').replace(/^builtin-/, '').toLowerCase();
}

/** The immutable run stores the same responses consumed by queries, plots and reports. */
export function enrichResultData(model: ModelRecord, result: ModelRecord, selection: ModelRecord): ModelRecord {
  const data = isRecord(result.data) ? result.data : result;
  if (result.success === false || !recoveryModel(model) || !isRecord(data.displacements)) return data;
  const source = { ...data, meta: { ...(isRecord(data.meta) ? data.meta : {}), ...(isRecord(result.meta) ? result.meta : {}) } };
  const memberResponses = recoverAnalysisMembers(model, source as RecoveryResult, resultEngine(result), resultFactors(model, selection));
  return { ...source, memberResponses, memberResponseExtrema: memberResponseExtrema(memberResponses) };
}

export function queryPhysicalResponse(model: ModelRecord, result: ModelRecord, elementId: string, positionM: number, side: 'left' | 'right') {
  if (!recoveryModel(model)) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
  const data = isRecord(result.data) ? result.data : result;
  const response = queryMemberResponse(model, data as RecoveryResult, resultEngine(result), elementId, positionM, side,
    resultFactors(model, isRecord(result.selection) ? result.selection : {}));
  if (!response) throw new Error('MEMBER_RESPONSE_UNAVAILABLE_OR_POSITION_INVALID');
  return { ...response, elementId, positionM, side,
    units: { position: 'm', displacement: 'm', force: 'kN', moment: 'kN.m' },
    provenance: response.state === 'interpolated' ? 'display-interpolation' : 'mechanics-recovery',
  };
}

export function reportResultRows(analysis: unknown) {
  if (!isRecord(analysis)) return [];
  const results = isRecord(analysis.results) ? analysis.results : { [String(analysis.selectedResultKey ?? 'analysis:default')]: analysis };
  return Object.entries(results).filter((entry): entry is [string, ModelRecord] => isRecord(entry[1])).map(([key, result]) => {
    const data = isRecord(result.data) ? result.data : result;
    return { key, executionStatus: result.executionStatus ?? (result.success === false ? 'failed' : 'completed'),
      capabilityStatus: result.capabilityStatus, summary: data.summary, memberResponseExtrema: data.memberResponseExtrema,
      source: result.meta, selection: result.selection };
  });
}

export function resultTableMarkdown(analysis: unknown, locale: 'zh' | 'en'): string {
  const rows = reportResultRows(analysis);
  if (!rows.length) return '';
  const cell = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const columns = locale === 'zh' ? '| 工况/组合 | 执行状态 | 能力完整性 | 运行来源 |' : '| Case / combination | Execution | Capability | Run source |';
  let markdown = '\n\n' + columns + '\n| --- | --- | --- | --- |\n' + rows.map((row) =>
    `| ${cell(row.key)} | ${cell(row.executionStatus)} | ${cell(row.capabilityStatus)} | ${cell(isRecord(row.source) ? row.source.runId : undefined)} |`).join('\n') + '\n';
  const samples = rows.flatMap((row) => {
    const extrema = isRecord(row.memberResponseExtrema) ? row.memberResponseExtrema : {};
    return Object.entries(isRecord(extrema.values) ? extrema.values : {}).flatMap(([component, point]) =>
      isRecord(point) && typeof point.value === 'number' && point.value !== 0
        ? [{ key: row.key, component, point }] : []);
  });
  if (samples.length) {
    markdown += locale === 'zh'
      ? '\n下表为各工况构件采样响应的有符号绝对值极值（非连续场精确极值）；位置沿物理构件起点量取。\n\n| 工况/组合 | 分量 | 数值 | 单位 | 构件 | 位置 (m) |\n'
      : '\nSigned absolute extrema at sampled member positions, not exact continuous-field extrema. Positions are measured from the physical member start.\n\n| Case / combination | Component | Value | Unit | Member | Position (m) |\n';
    markdown += '| --- | --- | --- | --- | --- | --- |\n';
    markdown += samples.map(({ key, component, point }) => `| ${cell(key)} | ${cell(component)} | ${cell(point.value)} | ${component.startsWith('u') ? 'm' : component.startsWith('M') || component === 'T' ? 'kN.m' : 'kN'} | ${cell(point.elementId)} | ${cell(point.position)} |`).join('\n') + '\n';
  }
  return markdown;
}
