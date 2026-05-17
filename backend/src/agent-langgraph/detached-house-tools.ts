import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentState } from './state.js';
import type { DetachedHouseApiClient } from '../services/detached-house-api-client.js';
import {
  createDetachedHouseDesignBasisEnvelope,
  createDetachedHouseNormalizedModelEnvelope,
  readDetachedHouseDesign,
} from './detached-house-artifacts.js';
import { convertDetachedHouseDesignToStructureModel } from '../services/detached-house-model-converter.js';

export const DETACHED_HOUSE_API_TOOL_IDS = [
  'classify_floor_roles',
  'generate_floor_rooms',
  'derive_global_constraints_from_layout',
  'propagate_floor_rooms',
  'generate_floor_walls',
  'reconcile_global_constraints',
  'generate_column_grid',
  'place_doors_windows',
  'generate_beam_layout',
  'size_members',
  'validate_residential_design',
] as const;

export type DetachedHouseApiToolId = typeof DETACHED_HOUSE_API_TOOL_IDS[number];

export function createDetachedHouseSetDesignBasisTool() {
  return tool(
    async (input: { designJson: string }, config: LangGraphRunnableConfig) => {
      const state = getAgentState(config);
      const toolName = 'detached_house_set_design_basis';
      const design = parseJsonObject(input.designJson, 'designJson');
      const envelope = createDetachedHouseDesignBasisEnvelope({
        design,
        previous: state?.artifacts?.designBasis,
        toolId: toolName,
      });
      const summary = summarizeDesignUpdate(true, toolName, design, envelope.revision, []);
      return toolResult(getToolCallId(config), toolName, JSON.stringify(summary), {
        artifacts: { designBasis: envelope },
        analysisResult: null,
        codeCheckResult: null,
        report: null,
      });
    },
    {
      name: 'detached_house_set_design_basis',
      description:
        'Initialize or replace the detached-house designBasis artifact from a JSON object string. ' +
        'Use this before calling detached_house_* design API tools.',
      schema: z.object({
        designJson: z.string().describe('Complete detached-house design JSON object as a string'),
      }),
    },
  );
}

export function createDetachedHouseApiTool(toolId: DetachedHouseApiToolId, apiClient: DetachedHouseApiClient) {
  const toolName = `detached_house_${toolId}`;
  return tool(
    async (input: { optionsJson?: string }, config: LangGraphRunnableConfig) => {
      const state = getAgentState(config);
      const existingDesign = readDetachedHouseDesign(state?.artifacts);
      if (!existingDesign) {
        throw new Error('No detached-house designBasis artifact available. Run detached_house_set_design_basis first.');
      }
      const options = input.optionsJson ? parseJsonObject(input.optionsJson, 'optionsJson') : {};
      const response = await apiClient.runTool(toolId, { design: existingDesign, options });
      const envelope = createDetachedHouseDesignBasisEnvelope({
        design: response.design,
        previous: state?.artifacts?.designBasis,
        toolId: toolName,
      });
      const summary = summarizeDesignUpdate(true, toolName, response.design, envelope.revision, response.issues);
      return toolResult(getToolCallId(config), toolName, JSON.stringify(summary), {
        artifacts: { designBasis: envelope },
        analysisResult: null,
        codeCheckResult: null,
        report: null,
      });
    },
    {
      name: toolName,
      description:
        `Run detached-house API tool ${toolId}. Reads detached-house designBasis from state; ` +
        'pass only optionsJson, not the full design.',
      schema: z.object({
        optionsJson: z.string().optional().describe('Optional JSON object string for tool options, such as {"floor_id":"F2"}'),
      }),
    },
  );
}

export function createDetachedHouseBuildAnalysisModelTool() {
  return tool(
    async (_input: Record<string, never>, config: LangGraphRunnableConfig) => {
      const state = getAgentState(config);
      const design = readDetachedHouseDesign(state?.artifacts);
      if (!design) {
        throw new Error('No detached-house designBasis artifact available. Run detached_house_set_design_basis first.');
      }
      if (!state?.artifacts?.designBasis) {
        throw new Error('Detached-house designBasis envelope is missing.');
      }
      const model = convertDetachedHouseDesignToStructureModel(design);
      const normalizedModel = createDetachedHouseNormalizedModelEnvelope({
        model,
        designBasis: state.artifacts.designBasis,
        toolId: 'detached_house_build_analysis_model',
      });
      const summary = summarizeModel(model);
      return toolResult(getToolCallId(config), 'detached_house_build_analysis_model', JSON.stringify(summary), {
        model,
        artifacts: { normalizedModel },
        analysisResult: null,
        codeCheckResult: null,
        report: null,
      });
    },
    {
      name: 'detached_house_build_analysis_model',
      description:
        'Convert the detached-house designBasis artifact into StructureModelV2 and store it in state.model. ' +
        'Use this instead of build_model for detached-house API output.',
      schema: z.object({}),
    },
  );
}

function toolResult(
  toolCallId: string,
  toolName: string,
  content: string,
  stateUpdate?: Partial<AgentState>,
): Command {
  return new Command({
    update: {
      ...(stateUpdate || {}),
      messages: [new ToolMessage({
        content,
        tool_call_id: toolCallId,
        name: toolName,
      })],
    },
  });
}

function getAgentState(config: LangGraphRunnableConfig): AgentState | undefined {
  return (config.configurable as { agentState?: AgentState } | undefined)?.agentState;
}

function getToolCallId(config: LangGraphRunnableConfig): string {
  const id = (config as unknown as { toolCall?: { id?: string } }).toolCall?.id;
  if (!id) throw new Error('Tool call ID not available in config');
  return id;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function summarizeDesignUpdate(
  success: boolean,
  toolName: string,
  design: Record<string, unknown>,
  revision: number,
  issues: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    success,
    tool: toolName,
    floorCount: Array.isArray(design.floors) ? design.floors.length : 0,
    issueCount: issues.length,
    revision,
    issues,
  };
}

function summarizeModel(model: Record<string, unknown>): Record<string, unknown> {
  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  const elements = Array.isArray(model.elements) ? model.elements : [];
  const stories = Array.isArray(model.stories) ? model.stories : [];
  return {
    success: true,
    schemaVersion: model.schema_version,
    storyCount: stories.length,
    nodeCount: nodes.length,
    elementCount: elements.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
