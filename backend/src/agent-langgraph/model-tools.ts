import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentState } from './state.js';
import type { AgentConfigurable } from './configurable.js';
import { applyModelEdits, commitModel, currentAnalysisError, invalidateAnalysis, isRecord, undoModel, type ModelEdit } from '../engineering/model-state.js';
import { normalizeEngineeringModel } from '../engineering/model-boundary.js';
import { queryPhysicalResponse, scalarResultQuantity } from '../engineering/result-data.js';
import { loadAnalysisRun } from '../engineering/analysis-runs.js';
import { randomUUID } from 'node:crypto';
import { mergeInputEvidence, unresolvedInputEvidence } from '../engineering/input-evidence.js';

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
    const { id, state } = context(config);
    if (input.baseRevision !== state.modelRevision) throw new Error(`MODEL_VERSION_CONFLICT: expected ${state.modelRevision}`);
    const update = undoModel(state, input.transactionId);
    return result(id, 'undo_model', { success: true, revision: update.modelRevision }, update);
  }, { name: 'undo_model', description: 'Restore a transaction before-state as a new revision; reject conflicting subsequent edits. / 撤销修改并生成新版本，冲突时拒绝。',
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
    const patch = input.resolutions.map(item => {
      if (item.selectedSource !== undefined && item.value !== undefined) throw new Error('INPUT_RESOLUTION_SOURCE_OR_VALUE_ONLY');
      if (item.selectedSource !== undefined && !existing.some(record => record.id === item.selectedSource
        && record.field === item.field && record.status === 'observed')) throw new Error('OBSERVED_INPUT_SOURCE_REQUIRED');
      if (item.selectedSource === undefined && item.value === undefined) throw new Error('INPUT_RESOLUTION_VALUE_REQUIRED');
      return { id: `review:${randomUUID()}`, field: item.field, status: 'resolved', required: true,
        resolution: { selectedSource: item.selectedSource, value: item.value, unit: item.unit, reason: item.reason },
        source: { userMessage: state.lastUserMessage } };
    });
    const inputEvidence = mergeInputEvidence(existing, patch) ?? [];
    return result(id, 'review_input', { inputEvidence, unresolved: unresolvedInputEvidence(inputEvidence),
      nextAction: 'Apply reviewed values to the draft/current model, then validate / 将复核值用于草稿或当前模型并校验' },
    { ...invalidateAnalysis(state), modelPending: Boolean(state.model), inputEvidence });
  }, { name: 'review_input', description: 'Resolve ambiguous/missing input after focused file review or an explicit user correction. Preserve original evidence; do not invent values. / 定点复核或用户明确补充后解决输入冲突，保留原始证据。',
    schema: z.object({ resolutions: z.array(z.object({ field: z.string().min(1), selectedSource: z.string().optional(),
      value: z.unknown().optional(), unit: z.string().optional(), reason: z.string().min(1) })).min(1) }) });
}

export function createQueryResultsTool() {
  return tool(async (input, config) => {
    const { state, id } = context(config);
    const run = input.runId ? state.analysisRuns?.[input.runId] ?? await loadAnalysisRun(input.runId) : state.analysisResult;
    if (!run) throw new Error('RUN_NOT_FOUND');
    const resultKey = input.resultKey ?? run.selectedResultKey;
    const selected = typeof resultKey === 'string' && isRecord(run.results) ? run.results[resultKey] : run;
    if (!isRecord(selected)) throw new Error('RESULT_NOT_FOUND');
    const data = isRecord(selected.data) ? selected.data : selected;
    let values: unknown = input.field ? data[input.field] : data;
    if (input.modeNumber !== undefined) {
      const modes = Array.isArray(data.modes) ? data.modes : isRecord(data.modal) ? data.modal.modes : undefined;
      values = Array.isArray(modes) ? modes.find(item => isRecord(item) && item.modeNumber === input.modeNumber) : undefined;
      if (values === undefined) throw new Error('MODE_NOT_FOUND');
    }
    if (input.timeIndex !== undefined) {
      const history = Array.isArray(data.timeHistory) ? data.timeHistory : [];
      values = history[input.timeIndex];
      if (values === undefined) throw new Error('TIME_INDEX_NOT_FOUND');
    }
    if (input.nodeId !== undefined) {
      const source = isRecord(values) && isRecord(values.nodes) ? values.nodes
        : isRecord(values) && isRecord(values.modeShape) ? values.modeShape : values;
      if (!isRecord(source) || source[input.nodeId] === undefined) throw new Error('RESULT_NODE_NOT_FOUND');
      values = source[input.nodeId];
    }
    if (input.elementId !== undefined) {
      if (input.positionM === undefined) throw new Error('MEMBER_POSITION_REQUIRED');
      const model = isRecord(run.modelSnapshot) ? run.modelSnapshot : !input.runId && !currentAnalysisError(state) ? state.model : undefined;
      if (!model) throw new Error('RESULT_MODEL_SNAPSHOT_REQUIRED');
      values = queryPhysicalResponse(model, selected, input.elementId, input.positionM, input.side ?? 'right');
    }
    let quantity: Record<string, unknown> | undefined;
    if (input.component !== undefined) {
      if (!input.quantityId || !input.unit || !(input.elementId || input.nodeId)) throw new Error('QUANTITY_LOCATION_ID_AND_UNIT_REQUIRED');
      quantity = { id: input.quantityId, runId: run.runId, selection: resultKey, component: input.component, unit: input.unit,
        value: scalarResultQuantity(values, input.component, input.unit, input.elementId !== undefined),
        location: input.elementId ? { kind: 'member', id: input.elementId, positionM: input.positionM, side: input.side ?? 'right' }
          : { kind: 'node', id: input.nodeId }, source: selected.meta,
        ...(input.timeIndex !== undefined ? { timeIndex: input.timeIndex } : {}),
        ...(input.modeNumber !== undefined ? { modeNumber: input.modeNumber } : {}) };
    }
    const response = { runId: run.runId, historical: Boolean(input.runId), current: !input.runId && !currentAnalysisError(state),
      resultKey, meta: selected.meta, resultKeys: isRecord(run.results) ? Object.keys(run.results) : [], values, ...(quantity ? { quantity } : {}) };
    return quantity ? result(id, 'query_results', response, { resultQuantities: { [`${String(run.runId)}:${input.quantityId}`]: quantity } }) : JSON.stringify(response);
  }, { name: 'query_results', description: 'Read authoritative signed results for a case/combination or historical run. / 查询指定工况、组合或历史运行的有符号结果。',
    schema: z.object({ runId: z.string().optional(), resultKey: z.string().optional(),
      nodeId: z.string().optional(), modeNumber: z.number().int().positive().optional(), timeIndex: z.number().int().nonnegative().optional(),
      quantityId: z.string().min(1).optional().describe('Stable ID for a requested report quantity / 指定报告数值的稳定ID。'),
      component: z.enum(['ux','uy','uz','rx','ry','rz','fx','fy','fz','mx','my','mz','N','V2','V3','T','M2','M3']).optional(),
      unit: z.enum(['m','mm','rad','kN','N','kN.m','N.m']).optional(),
      elementId: z.string().optional(), positionM: z.number().nonnegative().optional(), side: z.enum(['left', 'right']).optional(),
      field: z.enum(['displacements', 'forces', 'reactions', 'solverMesh', 'segmentResults', 'summary', 'modal', 'modes', 'timeHistory', 'memberResponses', 'memberResponseExtrema']).optional() }) });
}
