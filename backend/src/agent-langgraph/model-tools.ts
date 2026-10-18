import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentState } from './state.js';
import type { AgentConfigurable } from './configurable.js';
import { applyModelEdits, commitModel, contentHash, currentAnalysisError, invalidateStaleResults, isRecord, undoModel, type ModelEdit } from '../engineering/model-state.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { assertModelEditReadback, editCollectionSchema, engineeringModelSchema, modelEditGuidance, modelFieldEdit, normalizeModelEdits } from '../engineering/model-edit-contract.js';
import { queryPhysicalResponse, scalarResultQuantity } from '../engineering/result-data.js';
import { resolveNodalResultSelection, resultSelectionSchema, solverMeshQueryGuidance } from '../engineering/result-selection.js';
import { loadAnalysisRun } from '../engineering/analysis-runs.js';
import { isDisplacementSelection, PLACEHOLDER_DISPLACEMENT_ERROR, settlePlaceholderStiffness, stiffnessPlaceholderOf, withoutDisplacementComponents, withoutPlaceholderDisplacements } from '../engineering/stiffness-placeholder.js';
import { randomUUID } from 'node:crypto';
import { imageRegionSchema } from '../engineering/vision-evidence.js';
import { activeInputEvidence, analysisInputBinding, canonicalInputValue, evidenceSourceFile, isCanonicalModelField, mergeInputEvidence, unresolvedInputEvidence } from '../engineering/input-evidence.js';

function context(config: LangGraphRunnableConfig) {
  const dependencies = config.configurable as AgentConfigurable & { agentState: AgentState };
  const id = (config as LangGraphRunnableConfig & { toolCall?: { id: string } }).toolCall?.id;
  if (!id) throw new Error('TOOL_CALL_ID_REQUIRED');
  return { ...dependencies, id, state: dependencies.agentState };
}
function result(id: string, name: string, data: unknown, update: Partial<AgentState> = {}) {
  return new Command({ update: { ...update, messages: [new ToolMessage({ tool_call_id: id, name, content: JSON.stringify(data) })] } });
}
function analysisAvailability(state: Parameters<typeof currentAnalysisError>[0]) {
  const reason = currentAnalysisError(state);
  return { analysisCurrent: !reason, analysisReason: reason ?? null,
    ...(reason ? { instruction: 'Before querying computed results, checking or reporting, resolve the analysis reason. After a model change, run_analysis must complete again; historical results remain saved. / 查询计算结果、校核或报告前先解决分析状态问题；修改模型后须重新完成 run_analysis，历史结果仍保留。' } : {}) };
}

export function createEditModelTool() {
  return tool(async (input, config) => {
    const { id, state, structureProtocolClient } = context(config);
    if (!state.model) throw new Error('MODEL_REQUIRED');
    if (input.baseRevision !== state.modelRevision) throw new Error(`MODEL_VERSION_CONFLICT: expected ${state.modelRevision}`);
    const edits = normalizeModelEdits(state.model, input.edits as ModelEdit[], await engineeringModelSchema(structureProtocolClient));
    const edited = settlePlaceholderStiffness(applyModelEdits(state.model, edits), edits);
    const metadata = isRecord(edited.metadata) ? edited.metadata : {};
    edited.metadata = { ...metadata, inputEvidence: mergeInputEvidence(state.inputEvidence,
      Array.isArray(metadata.inputEvidence) ? metadata.inputEvidence.filter(isRecord) : []) };
    const model = await normalizeEngineeringModel(edited, structureProtocolClient);
    assertModelEditReadback(model, edits);
    const update = commitModel(state, model, input.label ?? 'edit_model');
    const changed = update.modelRevision !== state.modelRevision;
    return result(id, 'edit_model', { success: true, changed, revision: update.modelRevision,
      transaction: changed ? update.modelHistory.at(-1)?.id : null, ...analysisAvailability({ ...state, ...update }) }, update);
  }, {
    name: 'edit_model',
    description: `Atomically update physical objects using the latest returned revision and stable IDs. Combine all currently known material, section and member updates into ONE edit_model call. Issue only one model-changing tool call per assistant message; wait for its returned revision before another edit or undo. Never guess a future revision or reuse an earlier revision. Move existing loads, never duplicate. / 按最新返回版本及稳定对象ID原子修改；把已知材料、截面和构件修改合并成一次edit_model。每条助手消息只发起一次模型写入，等待返回新版本后再编辑或撤销，禁止猜测未来版本或复用旧版本。 ${Object.values(modelEditGuidance).join(' ')}`,
    schema: z.object({
      baseRevision: z.number().int().nonnegative().describe('Latest revision returned by query_model, edit_model or undo_model. Do not send another model write in the same assistant message. / 使用query_model、edit_model或undo_model最新返回的版本；同条助手消息不再发另一模型写入。'), label: z.string().optional(),
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
    return result(id, 'undo_model', { success: true, revision: update.modelRevision, ...analysisAvailability({ ...state, ...update }) }, update);
  }, { name: 'undo_model', description: 'Undo the selected transaction as a new revision, preserving unrelated later edits. Issue only one model-changing tool call per assistant message, wait for the latest revision, and reject conflicts with changed fields or references. / 选择性撤销指定事务，保留后续无关修改；每条助手消息只发起一次模型写入并等待最新版本；字段或引用冲突时拒绝。',
    schema: z.object({ baseRevision: z.number().int().nonnegative().describe('Latest returned model revision; await any earlier model edit or undo before requesting this operation. / 使用最新返回模型版本；先等待此前编辑或撤销完成。'), transactionId: z.string().optional() }) });
}

export function createQueryModelTool() {
  return tool(async (input, config) => {
    const { state, structureProtocolClient } = context(config);
    const model = state.model;
    const collection = input.collection && model ? model[input.collection] : model;
    const objects = input.ids && Array.isArray(collection) ? collection.filter((item) => isRecord(item) && input.ids!.includes(String(item.id))) : collection;
    return JSON.stringify({ revision: state.modelRevision, pending: state.modelPending, model: objects, ...analysisAvailability(state),
      ...(input.includeSchema ? { editGuidance: modelEditGuidance, editSchema: editCollectionSchema(await engineeringModelSchema(structureProtocolClient), input.collection) } : {}),
      inputEvidence: state.inputEvidence ?? [], inputIssues: unresolvedInputEvidence(state.inputEvidence),
      history: state.modelHistory?.map(({ beforeModel: _before, ...summary }) => summary) });
  }, { name: 'query_model', description: 'Read the current physical model, stable IDs, revision and modification history before editing. / 查询模型、对象ID、版本和修改历史。',
    schema: z.object({ collection: z.string().optional(), ids: z.array(z.string()).optional(), includeSchema: z.boolean().optional() }) });
}

export function createReviewInputTool() {
  return tool(async (input, config) => {
    const { state, id, structureProtocolClient } = context(config);
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
    const modelMappingsRequired: string[] = [];
    for (const item of patch) {
      if (!state.model || item.field.startsWith('file:') || item.field.startsWith('coverage.')) continue;
      const field = item.resolution.modelField ?? item.field;
      if (!item.resolution.modelField && !isCanonicalModelField(field)) {
        // Resolving what a drawing shows is distinct from locating its model
        // object. Keep the reviewed source; the hard model-binding check still
        // blocks execution until a concrete canonical mapping is supplied.
        modelMappingsRequired.push(field); continue;
      }
      const selected = existing.find(record => record.id === item.resolution.selectedSource);
      const value = item.resolution.value ?? selected?.normalizedValue ?? selected?.value;
      const unit = item.resolution.selectedSource !== undefined ? selected?.normalizedUnit ?? selected?.unit : item.resolution.unit;
      try {
        let converted: Record<string, unknown>;
        try { converted = canonicalInputValue(state.model, field, value, unit); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('INPUT_EVIDENCE_MODEL_FIELD_NOT_FOUND_OR_AMBIGUOUS:')) throw error;
          // An optional field may be reviewed before it is populated, but only
          // if the actual V2 schema accepts its owner, path and supplied type.
          normalizeModelEdits(state.model, [modelFieldEdit(state.model, field, value)], await engineeringModelSchema(structureProtocolClient));
          converted = canonicalInputValue(state.model, field, value, unit, true);
        }
        modelValues.push({ field, ...converted });
      }
      catch (error) { modelValueErrors.push({ field, reason: error instanceof Error ? error.message : String(error) }); }
    }
    if (modelValueErrors.length) throw new Error(`INPUT_REVIEW_INVALID: ${modelValueErrors.map(row => `${row.field}: ${row.reason}`).join('; ')} / 复核字段无效，未保存本次复核，模型与已有结果未变`);
    return result(id, 'review_input', { inputEvidence, unresolved: unresolvedInputEvidence(inputEvidence), modelValues, modelValueErrors, modelMappingsRequired,
      nextAction: 'Apply reviewed values to the draft/current model, then validate / 将复核值用于草稿或当前模型并校验' },
    { ...invalidateStaleResults(state), inputEvidence,
      ...(input.resolutions?.some(item => item.analysisParameters) ? { contextSeismicWorkflow } : {}) });
  }, { name: 'review_input', description: 'Resolve existing input evidence/issues; this proposes reviewed values and does NOT edit the model. For ordinary user text updates use edit_model directly. Supply EITHER value+unit OR selectedSource (an existing observed evidence ID), never both; user text is not a source ID. / 解决已有证据问题，仅提出复核值、不修改模型。普通文字补参直接使用edit_model；value+unit与selectedSource已有证据ID二选一，用户文字不是证据ID。',
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
      modelField: z.string().optional().describe('Canonical model field for a semantic observation, e.g. nodes.A.x / 语义识别值对应的规范模型字段') })).optional(),
      excludeSources: z.array(z.object({ sourceFile: z.string().min(1), reason: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)).min(1).optional() })).optional()
        .describe('Explicitly exclude unrelated source observations, preserving their contents and reason / 明确排除无关来源，保留内容与原因'),
    }).refine(value => Boolean(value.resolutions?.length || value.excludeSources?.length), 'INPUT_REVIEW_ACTION_REQUIRED') });
}

export function createQueryResultsTool() {
  return tool(async (requestedInput, config) => {
    const { state, id } = context(config);
    const run = requestedInput.runId ? state.analysisRuns?.[requestedInput.runId] ?? await loadAnalysisRun(requestedInput.runId) : state.analysisResult;
    if (!run) throw new Error('RUN_NOT_FOUND');
    if (requestedInput.nodeId && requestedInput.elementId) throw new Error('RESULT_LOCATION_AMBIGUOUS');
    const input = resolveNodalResultSelection(requestedInput);
    // Placeholder stiffness yields forces only; its displacements are never presented.
    const placeholder = stiffnessPlaceholderOf(run);
    if (placeholder && (isDisplacementSelection(input.field, input.component) || input.referenceNodeId !== undefined)) throw new Error(PLACEHOLDER_DISPLACEMENT_ERROR);
    const fieldResolution = requestedInput.field === undefined && input.field !== undefined
      ? { field: input.field, source: 'node-component-unit', component: input.component, unit: input.unit } : undefined;
    if (input.compareResultKeys && (input.resultKey || !isRecord(run.results) || !input.component || input.modeNumber !== undefined || input.timeIndex !== undefined
      || new Set(input.compareResultKeys).size !== input.compareResultKeys.length)) {
      throw new Error('RESULT_COMPARISON_REQUIRES_DISTINCT_STATIC_KEYS_AND_COMPONENT / 比较需指定互异静力结果及同一分量');
    }
    // An explicitly emitted default does not request a multi-case comparison.
    // The saved signed quantity and its selection remain unchanged.
    if (input.comparison && input.comparison !== 'absolute-max' && !input.compareResultKeys) throw new Error('RESULT_COMPARISON_KEYS_REQUIRED');
    const querySelection = (resultKey: unknown, timeIndex = input.timeIndex) => {
      if (typeof resultKey === 'string' && !isRecord(run.results) && resultKey !== run.selectedResultKey) {
        throw new Error('RESULT_NOT_FOUND');
      }
      const selected = typeof resultKey === 'string' && isRecord(run.results) ? run.results[resultKey] : run;
      if (!isRecord(selected)) throw new Error('RESULT_NOT_FOUND');
      if (selected.success === false || selected.executionStatus === 'failed') throw new Error('RESULT_UNAVAILABLE');
      const data = isRecord(selected.data) ? selected.data : selected;
      if (input.referenceNodeId !== undefined && (!input.nodeId || input.elementId || input.field !== 'displacements'
        || !input.component || !['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].includes(input.component)
        || input.modeNumber !== undefined || timeIndex !== undefined)) {
        throw new Error('NODE_DIFFERENCE_REQUIRES_STATIC_DISPLACEMENT_COMPONENT / 节点差值需指定静力位移或转角分量');
      }
      let values: unknown = input.field ? data[input.field] : data;
      let viewData: unknown = data;
      let time: number | undefined;
      let modalNormalization: Record<string, unknown> | undefined;
      if (timeIndex !== undefined && input.modeNumber !== undefined) throw new Error('RESULT_INDEX_CONFLICT');
      if (input.modeNumber !== undefined) {
        if (input.elementId || (input.field && !['displacements', 'modal', 'modes'].includes(input.field))) throw new Error('MODAL_FIELD_UNAVAILABLE');
        const modes = Array.isArray(data.modes) ? data.modes : isRecord(data.modal) ? data.modal.modes : undefined;
        values = Array.isArray(modes) ? modes.find(item => isRecord(item) && item.modeNumber === input.modeNumber) : undefined;
        if (values === undefined) throw new Error('MODE_NOT_FOUND');
        {
          if (input.component && (!input.nodeId || !['ux', 'uy', 'uz'].includes(input.component) || input.unit !== '1')) throw new Error('MODAL_TRANSLATION_REQUIRES_DIMENSIONLESS_UNIT');
          const shape = isRecord(values) && isRecord(values.modeShape) ? values.modeShape : {};
          const vectors = Object.values(shape);
          if (!vectors.length || vectors.some(v => !Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error('MODAL_SHAPE_UNAVAILABLE');
          const scale = Math.max(...(vectors as number[][]).flat().map(Math.abs));
          if (!(scale > 0)) throw new Error('MODAL_SHAPE_UNAVAILABLE');
          modalNormalization = { method: 'maximum-absolute-translational-component', divisor: scale, coordinateSystem: 'global', physicalDisplacement: false };
          const normalized = Object.fromEntries(Object.entries(shape).map(([node, vector]) => [node,
            Object.fromEntries(['ux', 'uy', 'uz'].map((component, index) => [component, (vector as number[])[index]! / scale]))]));
          viewData = { displacements: normalized, normalization: modalNormalization };
          if (input.component) values = normalized;
        }
      }
      if (timeIndex !== undefined) {
        const history = Array.isArray(data.timeHistory) ? data.timeHistory : [];
        values = history[timeIndex];
        if (values === undefined) throw new Error('TIME_INDEX_NOT_FOUND');
        if (!isRecord(values) || typeof values.time !== 'number' || !Number.isFinite(values.time)) throw new Error('TIME_INDEX_UNVERIFIED');
        time = values.time;
        viewData = { displacements: values.nodes, reactions: values.reactions, time, responseDefinition: data.responseDefinition };
        if (input.field && ['reactions', 'forces', 'velocities', 'accelerations'].includes(input.field)) values = values[input.field];
        else if (input.field && !['timeHistory', 'displacements'].includes(input.field)) throw new Error('TIME_HISTORY_FIELD_UNAVAILABLE');
      }
      if (input.nodeId !== undefined) {
        const availability = isRecord(data.nodalResponseAvailability) ? data.nodalResponseAvailability[input.nodeId] : undefined;
        if (input.component && isRecord(availability) && availability[input.component] === false) throw new Error('NODE_DOF_RESPONSE_UNAVAILABLE');
        const source = isRecord(values) && isRecord(values.nodes) ? values.nodes
          : isRecord(values) && isRecord(values.modeShape) ? values.modeShape : values;
        if (!isRecord(source)) throw new Error(`RESULT_FIELD_UNAVAILABLE: this result has no ${input.field ?? 'nodal'} values. / 该结果没有${input.field ?? '节点'}数据。`);
        if (source[input.nodeId] === undefined) throw new Error('RESULT_NODE_NOT_FOUND');
        values = source[input.nodeId];
      }
      if (input.elementId !== undefined) {
        if (timeIndex !== undefined) {
          if (input.field !== 'forces' || !input.end || input.positionM !== undefined || input.side !== undefined) throw new Error('DYNAMIC_MEMBER_END_REQUIRED');
          const member = isRecord(values) ? values[input.elementId] : undefined;
          if (!isRecord(member) || member.referenceFrame !== 'element-local' || !isRecord(member[input.end])) throw new Error('DYNAMIC_MEMBER_RESULT_UNAVAILABLE');
          values = member[input.end];
        } else {
        if (input.positionM === undefined) throw new Error('MEMBER_POSITION_REQUIRED: static elementId queries require positionM in metres from the physical member first node. Use 0 for the first end or the member length with side="left" for the final end; omit elementId to inspect the whole field. Do not edit or split the model just to query a position. / 静力构件查询须给距首节点的positionM（米）；首端0，末端为构件长度并用side="left"。查看整个字段可省略elementId，不需要为查询位置修改或拆分模型。');
        const model = isRecord(run.modelSnapshot) ? run.modelSnapshot : !input.runId && !currentAnalysisError(state) ? state.model : undefined;
        if (!model) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
        values = queryPhysicalResponse(model, selected, input.elementId, input.positionM, input.side ?? 'right');
        }
      }
      if (input.end && (timeIndex === undefined || !input.elementId)) throw new Error('DYNAMIC_MEMBER_END_ONLY');
      let quantity: Record<string, unknown> | undefined;
      if (input.component !== undefined) {
        if (!input.unit || !(input.elementId || input.nodeId)) throw new Error('QUANTITY_LOCATION_AND_UNIT_REQUIRED: component needs unit plus nodeId or elementId and its position/end. quantityId is generated automatically and requires no user input. / 指定component时必须给unit及nodeId或elementId和位置/端点；quantityId由系统自动生成，不需要用户提供。');
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
        const location = input.elementId ? { kind: 'member', id: input.elementId, ...(input.end ? { end: input.end } : { positionM: input.positionM, side: input.side ?? 'right' }) }
            : input.referenceNodeId ? { kind: 'node-pair', id: input.nodeId, referenceId: input.referenceNodeId }
              : { kind: 'node', id: input.nodeId };
        const quantityId = input.quantityId ?? `q_${contentHash({ runId: run.runId, resultKey, field: input.field,
          component: input.component, unit: input.unit, location, timeIndex, modeNumber: input.modeNumber,
          ...(input.compareResultKeys ? { compareResultKeys: input.compareResultKeys, comparison: input.comparison ?? 'absolute-max' } : {}) })}`;
        quantity = { id: quantityId, runId: run.runId, selection: resultKey, field: input.field, component: input.component, unit: input.unit,
          value: difference ? difference.value : value, location, source: selected.meta,
          responseSource: input.elementId && isRecord(values) ? { method: values.method, provenance: values.provenance, source: values.source }
            : { normalization: modalNormalization, responseDefinition: data.responseDefinition, source: data.source,
              objectSource: isRecord(data.objectSources) && input.nodeId ? data.objectSources[input.nodeId] : undefined },
          ...(difference ? { derivation: difference } : {}),
          ...(timeIndex !== undefined ? { timeIndex: timeIndex, time, responseDefinition: data.responseDefinition } : {}),
          ...(input.modeNumber !== undefined ? { modeNumber: input.modeNumber, normalization: modalNormalization } : {}) };
      }
      return { resultKey, meta: selected.meta, resultSelection: selected.selection, values, quantity, viewData };
    };
    if (input.series) {
      if (input.timeIndex !== undefined || input.modeNumber !== undefined || input.compareResultKeys || !input.component) throw new Error('TIME_SERIES_REQUIRES_SINGLE_RESULT_COMPONENT');
      const key = input.resultKey ?? run.selectedResultKey;
      const selected = isRecord(run.results) && typeof key === 'string' ? run.results[key] : run;
      const data = isRecord(selected) && isRecord(selected.data) ? selected.data : selected;
      const history = isRecord(data) && Array.isArray(data.timeHistory) ? data.timeHistory : [];
      const start = input.series.startIndex ?? 0;
      const end = input.series.endIndex ?? history.length - 1;
      const stride = input.series.stride ?? 1;
      if (start > end || end >= history.length || Math.floor((end - start) / stride) + 1 > 10000) throw new Error('TIME_SERIES_RANGE_INVALID_OR_TOO_LARGE');
      for (let index = start; index <= end; index++) {
        const row = history[index]; const previous = history[index - 1];
        if (!isRecord(row) || typeof row.time !== 'number' || !Number.isFinite(row.time)
          || (index > start && (!isRecord(previous) || typeof previous.time !== 'number' || row.time <= previous.time))) throw new Error('TIME_AXIS_NOT_STRICTLY_INCREASING');
      }
      const points: Record<string, unknown>[] = [];
      for (let index = start; index <= end; index += stride) {
        const { quantity } = querySelection(key, index);
        if (!quantity) throw new Error('TIME_SERIES_COMPONENT_REQUIRED');
        points.push({ timeIndex: index, time: quantity.time, value: quantity.value });
      }
      return JSON.stringify({ runId: run.runId, resultKey: key, ...(fieldResolution ? { fieldResolution } : {}), series: { points, startIndex: start, endIndex: end, stride,
        sampled: stride > 1, interpolation: 'none', component: input.component, unit: input.unit, field: input.field,
        location: { nodeId: input.nodeId, elementId: input.elementId, end: input.end }, responseDefinition: isRecord(data) ? data.responseDefinition : undefined } });
    }
    const candidates = (input.compareResultKeys ?? [input.resultKey ?? run.selectedResultKey]).map(key => querySelection(key));
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
    const { resultKey, meta, resultSelection, quantity } = chosen;
    const values = !placeholder ? chosen.values
      : input.elementId ? withoutDisplacementComponents(chosen.values)
        : !input.field && isRecord(chosen.values) ? withoutPlaceholderDisplacements(chosen.values, placeholder)
          : Array.isArray(chosen.values) ? chosen.values.map(member => isRecord(member) && Array.isArray(member.samples)
            ? { ...member, samples: member.samples.map(sample => withoutDisplacementComponents(sample)) } : member) : chosen.values;
    const viewData = placeholder && isRecord(chosen.viewData) ? withoutPlaceholderDisplacements(chosen.viewData, placeholder) : chosen.viewData;
    const modelSnapshot = isRecord(run.modelSnapshot) ? run.modelSnapshot : !input.runId && !currentAnalysisError(state) ? state.model : undefined;
    if (input.includeModelSnapshot && !modelSnapshot) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
    const response = { runId: run.runId, historical: Boolean(input.runId), current: !input.runId && !currentAnalysisError(state),
      ...(input.includeModelSnapshot ? { modelSnapshot, visualizationData: viewData, analysisType: run.analysis_type ?? run.analysisType } : {}),
      resultKey, meta, resultSelection, resultKeys: isRecord(run.results) ? Object.keys(run.results) : [],
      ...(fieldResolution ? { fieldResolution } : {}),
      ...(input.field === 'solverMesh' && isRecord(viewData) ? { queryGuidance: solverMeshQueryGuidance(viewData) } : {}),
      values, ...(quantity ? { quantity } : {}) };
    return quantity ? result(id, 'query_results', response, { resultQuantities: { [`${String(run.runId)}:${String(quantity.id)}`]: quantity } }) : JSON.stringify(response);
  }, { name: 'query_results', description: 'Read authoritative signed results for a case/combination or historical run. Use exactly one location: nodeId for nodal responses OR elementId with positionM/end for member responses; omit the other location ID. For a report scalar, supply component, unit and a node or physical member position; the returned quantity is saved with its provenance and an automatic ID. An omitted nodal field is resolved only from unambiguous component/unit pairs: displacement or rotation to displacements, force or moment to reactions; velocities/accelerations need an explicit field. The receipt states any field resolution. Interior displacement and force queries use physical elementId + positionM, never solverMesh internal node IDs, and do not require model edits or remeshing. / 查询指定工况、组合或历史运行的有符号结果。位置二选一：节点响应用nodeId，构件响应用elementId及positionM/end；另一个位置ID必须省略。报告标量需给分量、单位及节点或物理构件位置；返回数值自动编号并保存来源。节点省略字段时仅根据明确的分量及单位选择位移/转角displacements或力/力矩reactions，并在回执说明；速度/加速度须明确字段。跨内位移和内力用物理elementId + positionM，不要使用solverMesh内部节点ID，也不需要修改或细分模型。',
    schema: resultSelectionSchema.extend({
      includeModelSnapshot: z.boolean().optional().describe('Return the run-bound model and selected direct display data for a viewer. / 返回该运行模型及选定结果的显示数据。'),
      series: z.object({ startIndex: z.number().int().nonnegative().optional(), endIndex: z.number().int().nonnegative().optional(), stride: z.number().int().positive().optional() }).optional().describe('Recorded time series, at most 10000 explicit samples; no interpolation. Exclusive with timeIndex/modeNumber. / 实际记录时程，最多10000点，不插值。'),
      compareResultKeys: z.array(z.string().min(1)).min(2).max(256).optional().describe('Compare the same static scalar over distinct keys in one run; exclusive with resultKey. / 同一运行中比较指定互异静力结果的同一数值，与resultKey互斥。'),
      comparison: z.enum(['absolute-max', 'max', 'min']).optional().describe('Only used with compareResultKeys; omit for a single result. Default absolute-max retains the controlling sign. Explicit absolute-max without comparison keys is inert and does not create an envelope. / 仅配合compareResultKeys使用，单结果省略；默认按绝对值控制并保留符号。单结果附带该默认值不改变查询，也不生成包络。'),
      referenceNodeId: z.string().min(1).optional().describe('Static displacement: nodeId minus referenceNodeId; component and unit required. / 静力位移nodeId减referenceNodeId，需分量和单位。'),
      quantityId: z.string().min(1).optional().describe('Optional caller-chosen label; omitted IDs are generated deterministically from the exact result selection. Never ask the user for this internal ID. / 可选自定义标识；省略时由完整结果选择确定性生成，不应向用户索要此内部ID。'),
    }) });
}
