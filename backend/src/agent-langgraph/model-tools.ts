import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentState } from './state.js';
import type { AgentConfigurable } from './configurable.js';
import { applyModelEdits, commitModel, contentHash, currentAnalysisError, invalidateAnalysis, isRecord, undoModel, type ModelEdit } from '../engineering/model-state.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { queryPhysicalResponse, scalarResultQuantity } from '../engineering/result-data.js';
import { loadAnalysisRun } from '../engineering/analysis-runs.js';
import { randomUUID } from 'node:crypto';
import { imageRegionSchema } from '../engineering/vision-evidence.js';
import { activeInputEvidence, analysisInputBinding, canonicalInputValue, evidenceSourceFile, mergeInputEvidence, unresolvedInputEvidence } from '../engineering/input-evidence.js';

function context(config: LangGraphRunnableConfig) {
  const dependencies = config.configurable as AgentConfigurable & { agentState: AgentState };
  const id = (config as LangGraphRunnableConfig & { toolCall?: { id: string } }).toolCall?.id;
  if (!id) throw new Error('TOOL_CALL_ID_REQUIRED');
  return { ...dependencies, id, state: dependencies.agentState };
}
function result(id: string, name: string, data: unknown, update: Partial<AgentState> = {}) {
  return new Command({ update: { ...update, messages: [new ToolMessage({ tool_call_id: id, name, content: JSON.stringify(data) })] } });
}

export function createEditModelTool() {
  return tool(async (input, config) => {
    const { id, state, structureProtocolClient } = context(config);
    if (!state.model) throw new Error('MODEL_REQUIRED');
    if (input.baseRevision !== state.modelRevision) throw new Error(`MODEL_VERSION_CONFLICT: expected ${state.modelRevision}`);
    const edited = applyModelEdits(state.model, input.edits as ModelEdit[]);
    const metadata = isRecord(edited.metadata) ? edited.metadata : {};
    edited.metadata = { ...metadata, inputEvidence: mergeInputEvidence(state.inputEvidence,
      Array.isArray(metadata.inputEvidence) ? metadata.inputEvidence.filter(isRecord) : []) };
    const model = await normalizeEngineeringModel(edited, structureProtocolClient);
    const update = commitModel(state, model, input.label ?? 'edit_model');
    return result(id, 'edit_model', { success: true, revision: update.modelRevision, transaction: update.modelHistory.at(-1)?.id }, update);
  }, {
    name: 'edit_model',
    description: 'Atomically update named physical objects. Read query_model first; use its revision and stable IDs. Move an existing load by updating its position, never add a duplicate. / 按稳定对象ID原子修改、删除或添加。',
    schema: z.object({
      baseRevision: z.number().int().nonnegative(), label: z.string().optional(),
      edits: z.array(z.object({ operation: z.enum(['add', 'update', 'remove']),
        collection: z.enum(['nodes', 'elements', 'materials', 'sections', 'stories', 'load_cases', 'load_combinations', 'loads', 'model_settings']),
        id: z.string().min(1), caseId: z.string().optional(), values: z.record(z.string(), z.unknown()).optional(),
      })).min(1),
    }),
  });
}

export function createUndoModelTool() {
  return tool(async (input, config) => {
    const { id, state, structureProtocolClient } = context(config);
    if (input.baseRevision !== state.modelRevision) throw new Error(`MODEL_VERSION_CONFLICT: expected ${state.modelRevision}`);
    const candidate = undoModel(state, input.transactionId);
    const transaction = candidate.modelHistory.at(-1)!;
    const normalized = await normalizeEngineeringModel(candidate.model, structureProtocolClient);
    const update = commitModel(state, normalized, transaction.label, transaction.undoOf);
    return result(id, 'undo_model', { success: true, revision: update.modelRevision }, update);
  }, { name: 'undo_model', description: 'Undo the selected transaction as a new revision, preserving unrelated later edits. Reject conflicts with the changed fields or references. / 选择性撤销指定事务，保留后续无关修改；字段或引用冲突时拒绝。',
    schema: z.object({ baseRevision: z.number().int().nonnegative(), transactionId: z.string().optional() }) });
}

export function createQueryModelTool() {
  return tool(async (input, config) => {
    const { state } = context(config);
    const model = state.model;
    const collection = input.collection && model ? model[input.collection] : model;
    const objects = input.ids && Array.isArray(collection) ? collection.filter((item) => isRecord(item) && input.ids!.includes(String(item.id))) : collection;
    return JSON.stringify({ revision: state.modelRevision, pending: state.modelPending, model: objects,
      inputEvidence: state.inputEvidence ?? [], inputIssues: unresolvedInputEvidence(state.inputEvidence),
      history: state.modelHistory?.map(({ beforeModel: _before, ...summary }) => summary) });
  }, { name: 'query_model', description: 'Read the current physical model, stable IDs, revision and modification history before editing. / 查询模型、对象ID、版本和修改历史。',
    schema: z.object({ collection: z.string().optional(), ids: z.array(z.string()).optional() }) });
}

export function createReviewInputTool() {
  return tool(async (input, config) => {
    const { state, id } = context(config);
    const existing = state.inputEvidence ?? [];
    const contextSeismicWorkflow = structuredClone(state.contextSeismicWorkflow);
    const analysisSet = isRecord(contextSeismicWorkflow?.groundMotionSet) ? contextSeismicWorkflow.groundMotionSet : {};
    for (const item of input.resolutions ?? []) {
      if (!item.analysisParameters) continue;
      const records = Array.isArray(analysisSet.records) ? analysisSet.records.filter(isRecord).filter(record => record.id === item.analysisRecordId) : [];
      if (!item.analysisRecordId || records.length !== 1) throw new Error('ANALYSIS_INPUT_RECORD_NOT_FOUND');
      Object.assign(records[0]!, item.analysisParameters);
    }
    const patch = (input.resolutions ?? []).map(item => {
      if (item.selectedSource !== undefined && item.value !== undefined) throw new Error('INPUT_RESOLUTION_SOURCE_OR_VALUE_ONLY');
      if (item.selectedSource !== undefined && !existing.some(record => record.id === item.selectedSource
        && record.field === item.field && record.status === 'observed')) throw new Error('OBSERVED_INPUT_SOURCE_REQUIRED');
      if (item.selectedSource === undefined && item.value === undefined) throw new Error('INPUT_RESOLUTION_VALUE_REQUIRED');
      const sourceEvidence = item.sourceEvidenceId ? existing.find(record => record.id === item.sourceEvidenceId) : undefined;
      if (item.sourceEvidenceId && !sourceEvidence) throw new Error('INPUT_SOURCE_EVIDENCE_NOT_FOUND');
      const set = analysisSet;
      const records = Array.isArray(set.records) ? set.records.filter(isRecord).filter(record => record.id === item.analysisRecordId) : [];
      if (item.analysisRecordId && (records.length !== 1 || !item.sourceEvidenceId || !item.field.startsWith('file:'))) {
        throw new Error('ANALYSIS_INPUT_RECORD_NOT_FOUND');
      }
      return { id: `review:${randomUUID()}`, field: item.field, status: 'resolved', required: true,
        resolution: { selectedSource: item.selectedSource, value: item.value, unit: item.unit, reason: item.reason, modelField: item.modelField,
          mappedFields: item.mappedFields, sourceEvidenceId: item.sourceEvidenceId,
          ...(item.analysisRecordId ? { analysisInput: analysisInputBinding(records[0]!) } : {}) },
        source: { ...(sourceEvidence && isRecord(sourceEvidence.source) ? sourceEvidence.source : {}),
          ...item.sourceLocation, userMessage: state.lastUserMessage } };
    });
    const exclusions = (input.excludeSources ?? []).map(item => {
      const candidates = activeInputEvidence(existing).filter(record => evidenceSourceFile(record) === item.sourceFile
        && (!item.evidenceIds || item.evidenceIds.includes(String(record.id))));
      if (!candidates.length || item.evidenceIds?.some(id => !candidates.some(record => record.id === id))) throw new Error('INPUT_EXCLUSION_SOURCE_NOT_FOUND');
      return { id: `exclude:${randomUUID()}`, field: `file:${item.sourceFile}:exclusion`, status: 'excluded', required: false,
        resolution: { sourceFile: item.sourceFile, reason: item.reason, evidenceHashes: candidates.map(contentHash) },
        source: { userMessage: state.lastUserMessage } };
    });
    const inputEvidence = mergeInputEvidence(existing, [...patch, ...exclusions]) ?? [];
    const modelValues: Record<string, unknown>[] = [];
    const modelValueErrors: Record<string, unknown>[] = [];
    for (const item of patch) {
      if (!state.model || item.field.startsWith('file:') || item.field.startsWith('coverage.')) continue;
      const field = item.resolution.modelField ?? item.field;
      const selected = existing.find(record => record.id === item.resolution.selectedSource);
      const value = item.resolution.value ?? selected?.normalizedValue ?? selected?.value;
      const unit = item.resolution.selectedSource !== undefined ? selected?.normalizedUnit ?? selected?.unit : item.resolution.unit;
      try { modelValues.push({ field, ...canonicalInputValue(state.model, field, value, unit) }); }
      catch (error) { modelValueErrors.push({ field, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return result(id, 'review_input', { inputEvidence, unresolved: unresolvedInputEvidence(inputEvidence), modelValues, modelValueErrors,
      nextAction: 'Apply reviewed values to the draft/current model, then validate / 将复核值用于草稿或当前模型并校验' },
    { ...invalidateAnalysis(state), inputEvidence,
      ...(input.resolutions?.some(item => item.analysisParameters) ? { contextSeismicWorkflow } : {}) });
  }, { name: 'review_input', description: 'Review candidate fields with their source IDs; map files to model fields or a complete analysis-input record. Exclude irrelevant sources with reasons. Preserve evidence and never invent values. / 复核来源字段并绑定模型或完整分析输入；无关来源须说明排除理由，保留证据。',
    schema: z.object({ resolutions: z.array(z.object({ field: z.string().min(1), selectedSource: z.string().optional(),
      value: z.unknown().optional(), unit: z.string().optional(), reason: z.string().min(1),
      sourceEvidenceId: z.string().optional().describe('Retain the exact parsed source for a reviewed model field / 复核字段引用的原始解析证据'),
      sourceLocation: z.object({ row: z.number().int().positive().optional(), column: z.union([z.number().int().positive(),z.string().min(1)]).optional(),
        entityId: z.string().min(1).optional(), region: imageRegionSchema.optional(),
      }).optional().describe('Exact table row/column, CAD entity or image region for this field / 字段对应的表格行列、CAD实体或图像区域'),
      analysisRecordId: z.string().optional().describe('Ground-motion record ID from context; binds complete source and current sampling settings / 地震波记录ID，绑定完整来源与当前采样设置'),
      analysisParameters: z.object({ unit: z.string().min(1).optional(), direction: z.enum(['x', 'y']).optional(),
        dt: z.number().positive().optional(), timeUnit: z.enum(['s', 'ms']).optional(),
        timeColumn: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
        accelerationColumn: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
      }).optional().describe('Confirmed sampling parameters; original samples and file references cannot be replaced / 确认采样参数，不能替换原始样本或文件引用'),
      mappedFields: z.array(z.string().min(1)).min(1).optional().describe('Concrete reviewed fields used from this source / 该来源已复核并采用的具体字段'),
      modelField: z.string().optional().describe('Canonical model field for a semantic observation, e.g. nodes.A.x / 语义识别值对应的规范模型字段') })).min(1).optional(),
      excludeSources: z.array(z.object({ sourceFile: z.string().min(1), reason: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)).min(1).optional() })).min(1).optional()
        .describe('Explicitly exclude unrelated source observations, preserving their contents and reason / 明确排除无关来源，保留内容与原因'),
    }).refine(value => Boolean(value.resolutions?.length || value.excludeSources?.length), 'INPUT_REVIEW_ACTION_REQUIRED') });
}

export function createQueryResultsTool() {
  return tool(async (input, config) => {
    const { state, id } = context(config);
    const run = input.runId ? state.analysisRuns?.[input.runId] ?? await loadAnalysisRun(input.runId) : state.analysisResult;
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (input.compareResultKeys && (input.resultKey || !isRecord(run.results) || !input.component || input.modeNumber !== undefined || input.timeIndex !== undefined
      || new Set(input.compareResultKeys).size !== input.compareResultKeys.length)) {
      throw new Error('RESULT_COMPARISON_REQUIRES_DISTINCT_STATIC_KEYS_AND_COMPONENT / 比较需指定互异静力结果及同一分量');
    }
    if (input.comparison && !input.compareResultKeys) throw new Error('RESULT_COMPARISON_KEYS_REQUIRED');
    const querySelection = (resultKey: unknown) => {
      if (typeof resultKey === 'string' && !isRecord(run.results) && resultKey !== run.selectedResultKey) {
        throw new Error('RESULT_NOT_FOUND');
      }
      const selected = typeof resultKey === 'string' && isRecord(run.results) ? run.results[resultKey] : run;
      if (!isRecord(selected)) throw new Error('RESULT_NOT_FOUND');
      if (selected.success === false || selected.executionStatus === 'failed') throw new Error('RESULT_UNAVAILABLE');
      const data = isRecord(selected.data) ? selected.data : selected;
      if (input.referenceNodeId !== undefined && (!input.nodeId || input.elementId || input.field !== 'displacements'
        || !input.component || !['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].includes(input.component)
        || input.modeNumber !== undefined || input.timeIndex !== undefined)) {
        throw new Error('NODE_DIFFERENCE_REQUIRES_STATIC_DISPLACEMENT_COMPONENT / 节点差值需指定静力位移或转角分量');
      }
      let values: unknown = input.field ? data[input.field] : data;
      let time: number | undefined;
      let modalNormalization: Record<string, unknown> | undefined;
      if (input.timeIndex !== undefined && input.modeNumber !== undefined) throw new Error('RESULT_INDEX_CONFLICT');
      if (input.modeNumber !== undefined) {
        if (input.elementId || (input.field && !['displacements', 'modal', 'modes'].includes(input.field))) throw new Error('MODAL_FIELD_UNAVAILABLE');
        const modes = Array.isArray(data.modes) ? data.modes : isRecord(data.modal) ? data.modal.modes : undefined;
        values = Array.isArray(modes) ? modes.find(item => isRecord(item) && item.modeNumber === input.modeNumber) : undefined;
        if (values === undefined) throw new Error('MODE_NOT_FOUND');
        if (input.component) {
          if (!input.nodeId || !['ux', 'uy', 'uz'].includes(input.component) || input.unit !== '1') throw new Error('MODAL_TRANSLATION_REQUIRES_DIMENSIONLESS_UNIT');
          const shape = isRecord(values) && isRecord(values.modeShape) ? values.modeShape : {};
          const vectors = Object.values(shape);
          if (!vectors.length || vectors.some(v => !Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error('MODAL_SHAPE_UNAVAILABLE');
          const scale = Math.max(...(vectors as number[][]).flat().map(Math.abs));
          if (!(scale > 0)) throw new Error('MODAL_SHAPE_UNAVAILABLE');
          modalNormalization = { method: 'maximum-absolute-translational-component', divisor: scale, coordinateSystem: 'global', physicalDisplacement: false };
          values = Object.fromEntries(Object.entries(shape).map(([node, vector]) => [node,
            Object.fromEntries(['ux', 'uy', 'uz'].map((component, index) => [component, (vector as number[])[index]! / scale]))]));
        }
      }
      if (input.timeIndex !== undefined) {
        const history = Array.isArray(data.timeHistory) ? data.timeHistory : [];
        values = history[input.timeIndex];
        if (values === undefined) throw new Error('TIME_INDEX_NOT_FOUND');
        if (!isRecord(values) || typeof values.time !== 'number' || !Number.isFinite(values.time)) throw new Error('TIME_INDEX_UNVERIFIED');
        time = values.time;
        if (input.field && ['reactions', 'forces', 'velocities', 'accelerations'].includes(input.field)) values = values[input.field];
        else if (input.field && !['timeHistory', 'displacements'].includes(input.field)) throw new Error('TIME_HISTORY_FIELD_UNAVAILABLE');
      }
      if (input.nodeId !== undefined) {
        const availability = isRecord(data.nodalResponseAvailability) ? data.nodalResponseAvailability[input.nodeId] : undefined;
        if (input.component && isRecord(availability) && availability[input.component] === false) throw new Error('NODE_DOF_RESPONSE_UNAVAILABLE');
        const source = isRecord(values) && isRecord(values.nodes) ? values.nodes
          : isRecord(values) && isRecord(values.modeShape) ? values.modeShape : values;
        if (!isRecord(source) || source[input.nodeId] === undefined) throw new Error('RESULT_NODE_NOT_FOUND');
        values = source[input.nodeId];
      }
      if (input.elementId !== undefined) {
        if (input.timeIndex !== undefined) {
          if (input.field !== 'forces' || !input.end || input.positionM !== undefined || input.side !== undefined) throw new Error('DYNAMIC_MEMBER_END_REQUIRED');
          const member = isRecord(values) ? values[input.elementId] : undefined;
          if (!isRecord(member) || member.referenceFrame !== 'element-local' || !isRecord(member[input.end])) throw new Error('DYNAMIC_MEMBER_RESULT_UNAVAILABLE');
          values = member[input.end];
        } else {
        if (input.positionM === undefined) throw new Error('MEMBER_POSITION_REQUIRED');
        const model = isRecord(run.modelSnapshot) ? run.modelSnapshot : !input.runId && !currentAnalysisError(state) ? state.model : undefined;
        if (!model) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
        values = queryPhysicalResponse(model, selected, input.elementId, input.positionM, input.side ?? 'right');
        }
      }
      if (input.end && (input.timeIndex === undefined || !input.elementId)) throw new Error('DYNAMIC_MEMBER_END_ONLY');
      let quantity: Record<string, unknown> | undefined;
      if (input.component !== undefined) {
        if (!input.quantityId || !input.unit || !(input.elementId || input.nodeId)) throw new Error('QUANTITY_LOCATION_ID_AND_UNIT_REQUIRED');
        const value = modalNormalization && isRecord(values) ? values[input.component] as number
          : scalarResultQuantity(values, input.component, input.unit, input.elementId !== undefined, input.field);
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('RESULT_COMPONENT_UNAVAILABLE');
        let difference: Record<string, unknown> | undefined;
        if (input.referenceNodeId !== undefined) {
          const nodes = isRecord(data.displacements) ? data.displacements : {};
          const referenceValue = scalarResultQuantity(nodes[input.referenceNodeId], input.component, input.unit, false);
          if (!Number.isFinite(value - referenceValue)) throw new Error('RESULT_DIFFERENCE_NONFINITE');
          difference = { kind: 'node-difference', operation: 'minuend-minus-subtrahend',
            minuend: { nodeId: input.nodeId, value }, subtrahend: { nodeId: input.referenceNodeId, value: referenceValue },
            value: value - referenceValue, unit: input.unit, runId: run.runId, selection: resultKey };
        }
        quantity = { id: input.quantityId, runId: run.runId, selection: resultKey, field: input.field, component: input.component, unit: input.unit,
          value: difference ? difference.value : value,
          location: input.elementId ? { kind: 'member', id: input.elementId, ...(input.end ? { end: input.end } : { positionM: input.positionM, side: input.side ?? 'right' }) }
            : input.referenceNodeId ? { kind: 'node-pair', id: input.nodeId, referenceId: input.referenceNodeId }
              : { kind: 'node', id: input.nodeId }, source: selected.meta,
          ...(difference ? { derivation: difference } : {}),
          ...(input.timeIndex !== undefined ? { timeIndex: input.timeIndex, time, responseDefinition: data.responseDefinition } : {}),
          ...(input.modeNumber !== undefined ? { modeNumber: input.modeNumber, normalization: modalNormalization } : {}) };
      }
      return { resultKey, meta: selected.meta, values, quantity };
    };
    const candidates = (input.compareResultKeys ?? [input.resultKey ?? run.selectedResultKey]).map(querySelection);
    let chosen = candidates[0]!;
    if (input.compareResultKeys) {
      const comparison = input.comparison ?? 'absolute-max';
      const score = (candidate: typeof chosen) => {
        const value = candidate.quantity?.value;
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('RESULT_COMPARISON_FINITE_QUANTITY_REQUIRED');
        return comparison === 'absolute-max' ? Math.abs(value) : comparison === 'min' ? -value : value;
      };
      for (const candidate of candidates.slice(1)) if (score(candidate) > score(chosen)) chosen = candidate;
      chosen = { ...chosen, quantity: { ...chosen.quantity, comparison: {
        method: comparison, candidates: candidates.map(candidate => candidate.quantity),
        controllingResultKeys: candidates.filter(candidate => score(candidate) === score(chosen)).map(candidate => candidate.resultKey),
        tiePolicy: 'exact-score-equality-first-requested-key',
      } } };
    }
    const { resultKey, meta, values, quantity } = chosen;
    const response = { runId: run.runId, historical: Boolean(input.runId), current: !input.runId && !currentAnalysisError(state),
      resultKey, meta, resultKeys: isRecord(run.results) ? Object.keys(run.results) : [], values, ...(quantity ? { quantity } : {}) };
    return quantity ? result(id, 'query_results', response, { resultQuantities: { [`${String(run.runId)}:${input.quantityId}`]: quantity } }) : JSON.stringify(response);
  }, { name: 'query_results', description: 'Read authoritative signed results for a case/combination or historical run. / 查询指定工况、组合或历史运行的有符号结果。',
    schema: z.object({ runId: z.string().optional(), resultKey: z.string().optional(),
      compareResultKeys: z.array(z.string().min(1)).min(2).max(256).optional().describe('Compare the same requested quantity over these explicit result keys in ONE run, preserving signed values and controlling IDs. Exclusive with resultKey. / 在同一次运行中比较指定工况/组合的同一数值，保留符号和控制ID，与resultKey互斥。'),
      comparison: z.enum(['absolute-max', 'max', 'min']).optional().describe('Comparison criterion; defaults to absolute-max, returned value retains its sign. / 默认按绝对值控制，返回值保留原符号。'),
      nodeId: z.string().optional(), modeNumber: z.number().int().positive().optional(), timeIndex: z.number().int().nonnegative().optional(),
      referenceNodeId: z.string().min(1).optional().describe('Subtract this node from nodeId in the SAME static result; field=displacements and component/unit/quantityId required. For signed story displacement differences. / 同一静力结果内计算 nodeId 减此节点的位移差，需指定分量、单位和数值ID。'),
      quantityId: z.string().min(1).optional().describe('Stable ID for a requested report quantity / 指定报告数值的稳定ID。'),
      component: z.enum(['ux','uy','uz','rx','ry','rz','fx','fy','fz','mx','my','mz','N','V2','V3','T','M2','M3']).optional(),
      unit: z.enum(['m','mm','rad','kN','N','kN.m','N.m','m/s','mm/s','rad/s','m/s2','mm/s2','rad/s2','1']).optional(),
      elementId: z.string().optional(), positionM: z.number().nonnegative().optional(), side: z.enum(['left', 'right']).optional(),
      end: z.enum(['n1', 'n2']).optional().describe('Recorded physical member end for a time-history force query / 时程内力查询的物理构件端部。'),
      field: z.enum(['displacements', 'velocities', 'accelerations', 'forces', 'reactions', 'solverMesh', 'segmentResults', 'summary', 'modal', 'modes', 'timeHistory', 'memberResponses', 'memberResponseExtrema']).optional() }) });
}
