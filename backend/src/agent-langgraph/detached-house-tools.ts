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

const FLOOR_ID_REQUIRED_TOOLS = new Set<DetachedHouseApiToolId>([
  'generate_floor_rooms',
  'propagate_floor_rooms',
  'generate_floor_walls',
  'place_doors_windows',
  'generate_beam_layout',
]);

export function createDetachedHouseCreateDesignBasisTool() {
  return tool(
    async (input: {
      message: string;
      projectName?: string;
      floorCount?: number;
      outlineJson?: string;
      floorsJson?: string;
      structureType?: string;
    }, config: LangGraphRunnableConfig) => {
      const state = getAgentState(config);
      const toolName = 'detached_house_create_design_basis';
      const design = createDesignBasisFromIntent(input);
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
      name: 'detached_house_create_design_basis',
      description:
        'Create the detached-house designBasis artifact from user intent, extracted drawing data, and optional structured floor outlines. ' +
        'Use this as the entry point before calling detached_house_* design API tools.',
      schema: z.object({
        message: z.string().describe('User design intent or extracted drawing description'),
        projectName: z.string().optional().describe('Optional project name'),
        floorCount: z.number().int().positive().optional().describe('Optional number of floors'),
        outlineJson: z
          .string()
          .optional()
          .describe('Optional JSON polygon [[x,y],...] in millimeters for a shared floor outline'),
        floorsJson: z
          .string()
          .optional()
          .describe('Optional JSON array of floor objects from drawing extraction; may include id, outline, elevation, and height'),
        structureType: z.string().optional().describe('Optional structure type, default rc_frame'),
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
        throw new Error('No detached-house designBasis artifact available. Run detached_house_create_design_basis first.');
      }
      const options = input.optionsJson ? parseJsonObject(input.optionsJson, 'optionsJson') : {};
      validateFloorIdOption(toolName, toolId, existingDesign, options);
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
        throw new Error('No detached-house designBasis artifact available. Run detached_house_create_design_basis first.');
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

function createDesignBasisFromIntent(input: {
  message: string;
  projectName?: string;
  floorCount?: number;
  outlineJson?: string;
  floorsJson?: string;
  structureType?: string;
}): Record<string, unknown> {
  const message = input.message.trim();
  if (!message) throw new Error('message is required to create detached-house designBasis');
  const floorsFromInput = input.floorsJson ? parseFloorsJson(input.floorsJson) : null;
  const outline = input.outlineJson
    ? parsePolygon(input.outlineJson, 'outlineJson')
    : floorsFromInput
      ? parseRectangleOutlineFromMessageOrDefault(message)
      : parseRectangleOutlineFromMessage(message);
  const floorCount = input.floorCount ?? floorsFromInput?.length ?? parseFloorCount(message) ?? 3;
  const floors = floorsFromInput ?? createDefaultFloors(floorCount, outline);
  const normalizedFloors = normalizeFloors(floors, floorCount, outline);
  return {
    version: '0.1',
    project: {
      name: input.projectName?.trim() || 'Detached house',
      units: 'mm',
      structure_type: input.structureType?.trim() || 'rc_frame',
    },
    requirements: message,
    floors: normalizedFloors,
    layout_strategy: {
      generation_order: normalizedFloors.map((floor) => floor.id),
    },
  };
}

function parseFloorsJson(raw: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('floorsJson must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('floorsJson must be a JSON array');
  return parsed.filter(isRecord);
}

function parsePolygon(raw: string, label: string): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a polygon array`);
  const polygon = parsed
    .filter(Array.isArray)
    .map((point) => point.map((value) => (typeof value === 'number' ? value : Number.NaN)))
    .filter((point) => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [point[0], point[1]]);
  if (polygon.length < 3) throw new Error(`${label} must contain at least three points`);
  return polygon;
}

function parseRectangleOutlineFromMessage(message: string): number[][] {
  const match = message.match(/(\d+(?:\.\d+)?)\s*(m|米|mm|毫米)?\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(m|米|mm|毫米)?/);
  if (!match) {
    throw new Error('Could not infer floor outline from message. Provide dimensions such as 12m x 9m or pass outlineJson.');
  }
  const width = dimensionToMillimeters(Number(match[1]), match[2]);
  const depth = dimensionToMillimeters(Number(match[3]), match[4] ?? match[2]);
  return [[0, 0], [width, 0], [width, depth], [0, depth]];
}

function parseRectangleOutlineFromMessageOrDefault(message: string): number[][] {
  try {
    return parseRectangleOutlineFromMessage(message);
  } catch {
    return [[0, 0], [12000, 0], [12000, 9000], [0, 9000]];
  }
}

function parseFloorCount(message: string): number | undefined {
  const numeric = message.match(/(\d+)\s*(层|storeys?|stories|floors?)/i);
  if (numeric) return Number(numeric[1]);
  const zhDigits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  const zh = message.match(/([一二两三四五六])\s*层/);
  return zh ? zhDigits[zh[1]] : undefined;
}

function createDefaultFloors(floorCount: number, outline: number[][]): Array<Record<string, unknown>> {
  return Array.from({ length: floorCount }, (_value, index) => {
    const height = index === 0 ? 3600 : 3300;
    const elevation = index === 0 ? 0 : 3600 + (index - 1) * 3300;
    return {
      id: `F${index + 1}`,
      name: `Level ${index + 1}`,
      elevation,
      height,
      outline,
    };
  });
}

function normalizeFloors(
  floors: Array<Record<string, unknown>>,
  floorCount: number,
  fallbackOutline: number[][],
): Array<Record<string, unknown>> {
  const sourceFloors = floors.length > 0 ? floors : createDefaultFloors(floorCount, fallbackOutline);
  return sourceFloors.map((floor, index) => {
    const height = typeof floor.height === 'number' ? floor.height : (index === 0 ? 3600 : 3300);
    const elevation = typeof floor.elevation === 'number' ? floor.elevation : (index === 0 ? 0 : 3600 + (index - 1) * 3300);
    return {
      id: typeof floor.id === 'string' && floor.id.trim() ? floor.id : `F${index + 1}`,
      name: typeof floor.name === 'string' && floor.name.trim() ? floor.name : `Level ${index + 1}`,
      elevation,
      height,
      outline: Array.isArray(floor.outline) ? floor.outline : fallbackOutline,
      ...floor,
    };
  });
}

function dimensionToMillimeters(value: number, unit: string | undefined): number {
  const normalized = unit?.toLowerCase();
  if (normalized === 'mm' || normalized === '毫米') return Math.round(value);
  return Math.round(value * 1000);
}

function summarizeDesignUpdate(
  success: boolean,
  toolName: string,
  design: Record<string, unknown>,
  revision: number,
  issues: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const floorSummaries = summarizeFloors(design);
  return {
    success,
    tool: toolName,
    floorCount: floorSummaries.length,
    floorIds: floorSummaries.map((floor) => floor.id),
    floors: floorSummaries,
    layoutStrategy: isRecord(design.layout_strategy) ? design.layout_strategy : undefined,
    issueCount: issues.length,
    revision,
    issues,
  };
}

function validateFloorIdOption(
  toolName: string,
  toolId: DetachedHouseApiToolId,
  design: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  if (!FLOOR_ID_REQUIRED_TOOLS.has(toolId)) return;
  const floorIds = getFloorIds(design);
  const floorId = options.floor_id;
  if (typeof floorId !== 'string' || floorId.trim().length === 0) {
    throw new Error(`${toolName} requires optionsJson.floor_id. Available floor_ids: ${floorIds.join(', ') || '(none)'}`);
  }
  if (!floorIds.includes(floorId)) {
    throw new Error(`Invalid floor_id '${floorId}' for ${toolName}. Available floor_ids: ${floorIds.join(', ') || '(none)'}`);
  }
}

function summarizeFloors(design: Record<string, unknown>): Array<Record<string, unknown>> {
  const floors = Array.isArray(design.floors) ? design.floors : [];
  return floors
    .filter(isRecord)
    .map((floor) => ({
      id: floor.id,
      role: floor.role,
      reference_floor_id: floor.reference_floor_id,
      hasRooms: Array.isArray(floor.rooms) && floor.rooms.length > 0,
      hasWalls: Array.isArray(floor.walls) && floor.walls.length > 0,
      hasOpenings: Array.isArray(floor.openings) && floor.openings.length > 0,
      hasColumns: Array.isArray(floor.columns) && floor.columns.length > 0,
      hasBeams: Array.isArray(floor.beams) && floor.beams.length > 0,
    }))
    .filter((floor) => typeof floor.id === 'string' && floor.id.length > 0);
}

function getFloorIds(design: Record<string, unknown>): string[] {
  return summarizeFloors(design).map((floor) => String(floor.id));
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
