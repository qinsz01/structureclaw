import { recoverAnalysisMembers, queryMemberResponse, memberResponseExtrema } from '../agent-skills/result-postprocess/member-response.js';
import type { RecoveryModel, RecoveryResult } from '../skill-shared/member-response.js';
import { isRecord, type ModelRecord } from './model-state.js';
import { nativeForceRecovery } from './native-force-recovery.js';

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
  const data = isRecord(result.data) ? result.data : result;
  const dataMeta = isRecord(data.meta) ? data.meta : {};
  const native = isRecord(data.nativeContext) ? data.nativeContext : {};
  return String(meta.engineId ?? dataMeta.engineId ?? native.engine ?? '').replace(/^builtin-/, '').toLowerCase();
}

const nativeComponents = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const;
const displayComponents = ['N', 'V2', 'V3', 'T', 'M2', 'M3'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const commercial = (result: ModelRecord) => ['yjk', 'pkpm'].includes(resultEngine(result));

function nativeStations(model: RecoveryModel, data: ModelRecord, elementId: string) {
  const context = isRecord(data.nativeContext) ? data.nativeContext : {};
  if (context.stationConventionsVerified !== true || data.forceSemantics !== 'simultaneous-signed-stations') {
    throw new Error('NATIVE_STATION_CONVENTIONS_UNVERIFIED');
  }
  const units = isRecord(data.units) ? data.units : {};
  if (units.force !== 'kN' || units.moment !== 'kN.m') throw new Error('NATIVE_STATION_UNITS_UNVERIFIED');
  const member = model.elements.find(item => item.id === elementId);
  const start = member && model.nodes.find(item => item.id === member.nodes[0]);
  const end = member && model.nodes.find(item => item.id === member.nodes[1]);
  if (!member || member.nodes.length !== 2 || !start || !end
    || ![start.x, start.y, start.z, end.x, end.y, end.z].every(finite)) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
  const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  if (length <= 0) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
  const sourceRows = isRecord(data.memberStations) ? data.memberStations[elementId] : undefined;
  if (!Array.isArray(sourceRows) || !sourceRows.length) throw new Error('EXACT_NATIVE_STATION_UNAVAILABLE');
  const seen = new Set<string>();
  const cuts = new Map<number, Set<string>>();
  const rows = sourceRows.map(raw => {
    if (!isRecord(raw) || !finite(raw.positionM) || raw.positionM < 0 || raw.positionM > length + 1e-9
      || !['left', 'right', 'continuous'].includes(String(raw.side)) || raw.referenceFrame !== 'element-local') {
      throw new Error('NATIVE_STATION_POSITION_UNVERIFIED');
    }
    if (!isRecord(raw.components) || !nativeComponents.every(key => finite((raw.components as ModelRecord)[key]))) {
      throw new Error('NATIVE_STATION_COMPONENTS_INCOMPLETE');
    }
    const identity = `${raw.positionM}:${raw.side}`;
    const sides = cuts.get(raw.positionM) ?? new Set<string>();
    if (seen.has(identity) || sides.has('continuous') || (raw.side === 'continuous' && sides.size)) {
      throw new Error('NATIVE_STATION_POSITION_AMBIGUOUS');
    }
    seen.add(identity);
    sides.add(String(raw.side));
    cuts.set(raw.positionM, sides);
    const sourceKind = isRecord(raw.source) ? raw.source.kind : raw.source;
    const provenance = sourceKind === 'linear-combination' || (isRecord(data.source) && data.source.kind === 'linear-combination')
      ? 'linear-combination' : 'solver-direct';
    if (!raw.source) throw new Error('NATIVE_STATION_SOURCE_UNAVAILABLE');
    return { ...raw, positionM: raw.positionM, side: raw.side, source: raw.source,
      components: raw.components, provenance };
  }).sort((a, b) => a.positionM - b.positionM || (a.side === 'left' ? -1 : 1));
  return { rows, length, start, end, context };
}

/** Native force samples carry no made-up cross-section displacement. */
function nativeMemberData(model: RecoveryModel, data: ModelRecord, factors?: Record<string, number>) {
  const extrema: Record<string, ModelRecord> = {};
  const memberResponses = model.elements.map(member => {
    try {
      const stations = nativeStations(model, data, member.id);
      const { length, start, end } = stations;
      let rows = stations.rows;
      try {
        const recovered = nativeForceRecovery(model, data, member.id, rows, length, factors);
        const positions = [...new Set([...Array.from({length:81},(_,i)=>length*i/80),...recovered.breakpoints])].sort((a,b)=>a-b);
        for(const positionM of positions) {
          const sides: ('left'|'right')[] = positionM===0?['right']:positionM===length?['left']:
            recovered.jumps.includes(positionM)?['left','right']:['right'];
          for(const side of sides) if(!rows.some(row=>Math.abs(row.positionM-positionM)<=1e-9 && (row.side===side||row.side==='continuous'))) {
            rows.push({positionM,side,components:recovered.at(positionM,side),source:recovered.source,provenance:'mechanics-recovery'});
          }
        }
        rows=rows.sort((a,b)=>a.positionM-b.positionM||(a.side==='left'?-1:1));
      } catch { /* Verified direct stations remain useful when equilibrium recovery is unavailable. */ }
      const samples = rows.map(row => {
        const components = Object.fromEntries(displayComponents.map((key, index) => [key, row.components[nativeComponents[index]]]));
        for (const [component, value] of Object.entries(components)) {
          if (finite(value) && (!extrema[component] || Math.abs(value) > Math.abs(Number(extrema[component].value)))) {
            extrema[component] = { elementId: member.id, position: row.positionM, value, side: row.side,
              provenance: row.provenance, source: row.source };
          }
        }
        const fraction = row.positionM / length;
        return { x: row.positionM, position: [start.x + fraction * (end.x - start.x),
          start.y + fraction * (end.y - start.y), start.z + fraction * (end.z - start.z)],
          ...(row.side === 'continuous' ? {} : { side: row.side }),
          ...components, provenance: row.provenance, source: row.source };
      });
      return { id: member.id, length, state: 'native-stations', reason: 'verified-native-stations', samples };
    } catch (error) {
      return { id: member.id, length: 0, state: 'unavailable',
        reason: error instanceof Error ? error.message : 'NATIVE_STATION_UNAVAILABLE', samples: [] };
    }
  });
  return { memberResponses, memberResponseExtrema: { method: 'native-station-sampled-envelope', values: extrema } };
}

/** The immutable run stores the same responses consumed by queries, plots and reports. */
export function enrichResultData(model: ModelRecord, result: ModelRecord, selection: ModelRecord): ModelRecord {
  const data = isRecord(result.data) ? result.data : result;
  if (result.success === false || !recoveryModel(model)) return data;
  const source = { ...data, meta: { ...(isRecord(data.meta) ? data.meta : {}), ...(isRecord(result.meta) ? result.meta : {}) } };
  if (commercial(result) || isRecord(data.memberStations)) return { ...source, ...nativeMemberData(model, source, resultFactors(model, selection)) };
  if (!isRecord(data.displacements)) return data;
  const memberResponses = recoverAnalysisMembers(model, source as RecoveryResult, resultEngine(result), resultFactors(model, selection));
  const extrema = memberResponseExtrema(memberResponses);
  return { ...source, memberResponses, memberResponseExtrema: { ...extrema,
    values: Object.fromEntries(Object.entries(extrema.values).map(([component, point]) => [component, { ...point,
      provenance: memberResponses.find(member => member.id === point.elementId)?.state === 'interpolated'
        ? 'display-interpolation' : 'mechanics-recovery' }])) } };
}

export function queryPhysicalResponse(model: ModelRecord, result: ModelRecord, elementId: string, positionM: number, side: 'left' | 'right') {
  if (!recoveryModel(model)) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
  if (result.success === false) throw new Error('RESULT_UNAVAILABLE');
  const data = isRecord(result.data) ? result.data : result;
  if (commercial(result) || isRecord(data.memberStations)) {
    const { rows, context, length } = nativeStations(model, data, elementId);
    if (!Number.isFinite(positionM) || positionM < 0) throw new Error('MEMBER_RESPONSE_UNAVAILABLE_OR_POSITION_INVALID');
    const exact = rows.filter(row => Math.abs(row.positionM - positionM) <= 1e-9
      && (row.side === side || row.side === 'continuous'));
    if (exact.length !== 1 || !isRecord(exact[0]) || !isRecord(exact[0].components)) {
      try {
        const factors = isRecord(data.source) && data.source.kind === 'linear-combination' && isRecord(data.source.factors)
          ? data.source.factors as Record<string, number> : resultFactors(model, isRecord(result.selection) ? result.selection : {});
        const recovery = nativeForceRecovery(model, data, elementId, rows, length, factors);
        const values = recovery.at(positionM,side);
        return {elementId,positionM,side,method:'section-equilibrium' as const,state:'recovered' as const,
          sample:{...values,V2:values.Vy,V3:values.Vz,M2:values.My,M3:values.Mz},
          units:{position:'m',force:'kN',moment:'kN.m'},provenance:'mechanics-recovery',source:recovery.source,nativeContext:context};
      } catch { throw new Error('EXACT_NATIVE_STATION_UNAVAILABLE'); }
    }
    const values = exact[0].components;
    if (!['N', 'Vy', 'Vz', 'T', 'My', 'Mz'].every((key) => typeof values[key] === 'number' && Number.isFinite(values[key]))) {
      throw new Error('NATIVE_STATION_COMPONENTS_INCOMPLETE');
    }
    // Aliases are axis names only. No nodal interpolation is exposed as a
    // solver displacement, and no nearest station is substituted for x.
    return { elementId, positionM, side, method: 'native-station' as const, state: 'solver' as const,
      sample: { ...values, N: values.N as number, V2: values.Vy as number, V3: values.Vz as number,
        T: values.T as number, M2: values.My as number, M3: values.Mz as number },
      units: { position: 'm', force: 'kN', moment: 'kN.m' }, provenance: exact[0].provenance,
      source: exact[0].source, nativeContext: context };
  }
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
      isRecord(point) && typeof point.value === 'number'
        ? [{ key: row.key, component, point }] : []);
  });
  if (samples.length) {
    markdown += locale === 'zh'
      ? '\n下表为各工况构件采样响应的有符号绝对值极值（非连续场精确极值）；位置沿物理构件起点量取。原生内力站点不提供未经验证的跨内位移。\n\n| 工况/组合 | 分量 | 数值 | 单位 | 构件 | 位置 (m) | 侧别 | 来源 |\n'
      : '\nSigned absolute extrema at sampled member positions, not exact continuous-field extrema. Positions are measured from the physical member start. Native force stations do not imply verified interior displacement.\n\n| Case / combination | Component | Value | Unit | Member | Position (m) | Side | Provenance |\n';
    markdown += '| --- | --- | --- | --- | --- | --- | --- | --- |\n';
    markdown += samples.map(({ key, component, point }) => `| ${cell(key)} | ${cell(component)} | ${cell(point.value)} | ${component.startsWith('u') ? 'm' : component.startsWith('M') || component === 'T' ? 'kN.m' : 'kN'} | ${cell(point.elementId)} | ${cell(point.position)} | ${cell(point.side)} | ${cell(point.provenance ?? 'mechanics-recovery')} |`).join('\n') + '\n';
  }
  const quantities = isRecord(analysis) && Array.isArray(analysis.requestedQuantities)
    ? analysis.requestedQuantities.filter(isRecord).filter(item => item.runId === analysis.runId) : [];
  if (quantities.length) {
    markdown += locale === 'zh' ? '\n指定位置查询结果（位置沿物理构件起点量取）：\n\n'
      : '\nRequested quantities (member positions measured from the physical start):\n\n';
    markdown += '| ID | Selection | Location | Component | Value | Unit |\n| --- | --- | --- | --- | --- | --- |\n';
    markdown += quantities.map(q => {
      const location = isRecord(q.location) ? q.location : {};
      const position = location.kind === 'member' ? `${location.id}@${location.positionM}:${location.side}` : location.id;
      return `| ${cell(q.id)} | ${cell(q.selection)} | ${cell(position)} | ${cell(q.component)} | ${cell(q.value)} | ${cell(q.unit)} |`;
    }).join('\n') + '\n';
  }
  return markdown;
}

/** Unit conversion is explicit; interpolation never becomes a recovered member force. */
export function scalarResultQuantity(values: unknown, component: string, unit: string, member: boolean) {
  if (!isRecord(values)) throw new Error('RESULT_COMPONENT_UNAVAILABLE');
  if (member && (values.method === 'nearest-sample' || values.state === 'interpolated')) throw new Error('EXACT_MEMBER_RESPONSE_UNAVAILABLE');
  const source = member && isRecord(values.sample) ? values.sample : values;
  const displacementIndex = ['ux', 'uy', 'uz'].indexOf(component);
  const raw = member && displacementIndex >= 0 && Array.isArray(source.displacement)
    ? source.displacement[displacementIndex] : source[component];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('RESULT_COMPONENT_UNAVAILABLE');
  const dimension = /^u[xyz]$/.test(component) ? 'length' : /^r[xyz]$/.test(component) ? 'rotation'
    : ['T', 'M2', 'M3', 'My', 'Mz', 'mx', 'my', 'mz'].includes(component) ? 'moment' : 'force';
  const units: Record<string, [string, number]> = { m: ['length', 1], mm: ['length', 1000],
    rad: ['rotation', 1], kN: ['force', 1], N: ['force', 1000], 'kN.m': ['moment', 1], 'N.m': ['moment', 1000] };
  const target = units[unit];
  if (!target || target[0] !== dimension) throw new Error('RESULT_UNIT_MISMATCH');
  return raw*target[1];
}
