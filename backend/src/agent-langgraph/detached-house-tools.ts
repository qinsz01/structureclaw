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
  'derive_global_constraints_from_layout',
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
        'Use this as the entry point before calling detached_house_* design tools.',
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
        floorId: typeof options.floor_id === 'string' ? options.floor_id : undefined,
        referenceFloorId: typeof options.reference_floor_id === 'string' ? options.reference_floor_id : undefined,
      });
      const summary = summarizeDesignUpdate(true, toolName, response.design, envelope.revision, response.issues, {
        targetFloorId: typeof options.floor_id === 'string' ? options.floor_id : undefined,
      });
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
        `Run detached-house design stage ${toolId}. Reads detached-house designBasis from state; ` +
        'pass only optionsJson, not the full design. Use optionsJson.stage_requirements for current-stage user notes.',
      schema: z.object({
        optionsJson: z
          .string()
          .optional()
          .describe('Optional JSON object string, e.g. {"floor_id":"F2","stage_requirements":"avoid columns in the living room"}'),
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
        'Use this instead of build_model for detached-house design output.',
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
  options: { targetFloorId?: string } = {},
): Record<string, unknown> {
  const floorSummaries = summarizeFloors(design);
  const stageIssues = buildStageConsistencyIssues(toolName, design, options.targetFloorId);
  const allIssues = [...issues, ...stageIssues];
  const effectiveSuccess = success && !allIssues.some((issue) => issue.level === 'error');
  const completionStatus = effectiveSuccess && allIssues.length === 0 ? 'ok' : 'needs_attention';
  return {
    success: effectiveSuccess,
    tool: toolName,
    floorCount: floorSummaries.length,
    floorIds: floorSummaries.map((floor) => floor.id),
    floors: floorSummaries,
    targetFloor: summarizeTargetFloor(design, options.targetFloorId, allIssues),
    layoutStrategy: isRecord(design.layout_strategy) ? design.layout_strategy : undefined,
    completionStatus,
    replyGuidance: buildReplyGuidance(completionStatus, options.targetFloorId),
    issueCount: allIssues.length,
    revision,
    issues: allIssues,
  };
}

function buildStageConsistencyIssues(
  toolName: string,
  design: Record<string, unknown>,
  targetFloorId: string | undefined,
): Array<Record<string, unknown>> {
  const floors = Array.isArray(design.floors) ? design.floors.filter(isRecord) : [];
  const targetFloors = targetFloorId
    ? floors.filter((candidate) => candidate.id === targetFloorId)
    : floors;
  return targetFloors.flatMap((floor) => buildFloorStageConsistencyIssues(toolName, floor, String(floor.id || 'unknown_floor')));
}

function buildFloorStageConsistencyIssues(
  toolName: string,
  floor: Record<string, unknown>,
  targetFloorId: string,
): Array<Record<string, unknown>> {
  const rooms = recordArray(floor.rooms);
  const walls = recordArray(floor.walls);
  const openings = recordArray(floor.openings);
  const columns = recordArray(floor.columns);
  const beams = recordArray(floor.beams);
  const issues: Array<Record<string, unknown>> = [];
  const invalidRoomIds = invalidRoomSchemaIds(rooms);
  if (invalidRoomIds.length > 0) {
    issues.push(schemaIssue(targetFloorId, 'room', invalidRoomIds, toolName));
  }
  const invalidWallIds = invalidWallSchemaIds(walls);
  if (invalidWallIds.length > 0) {
    issues.push(schemaIssue(targetFloorId, 'wall', invalidWallIds, toolName));
  }
  const invalidOpeningIds = invalidOpeningSchemaIds(openings);
  if (invalidOpeningIds.length > 0) {
    issues.push(schemaIssue(targetFloorId, 'opening', invalidOpeningIds, toolName));
  }
  const invalidColumnIds = invalidColumnSchemaIds(columns);
  if (invalidColumnIds.length > 0) {
    issues.push(schemaIssue(targetFloorId, 'column', invalidColumnIds, toolName));
  }
  const invalidBeamIds = invalidBeamSchemaIds(beams);
  if (invalidBeamIds.length > 0) {
    issues.push(schemaIssue(targetFloorId, 'beam', invalidBeamIds, toolName));
  }
  if (toolName === 'detached_house_generate_floor_walls' && rooms.length > 0 && walls.length === 0) {
    issues.push({
      id: `stage_walls_missing_${targetFloorId}`,
      level: 'error',
      floor_id: targetFloorId,
      message: `Floor ${targetFloorId} has rooms but no generated walls; wall generation did not produce drawable wall geometry.`,
      source_tool: 'detached_house_generate_floor_walls',
    });
  }
  if (rooms.length > 0 && openings.length > 0 && walls.length === 0) {
    issues.push({
      id: `stage_prerequisite_missing_walls_${targetFloorId}`,
      level: 'error',
      floor_id: targetFloorId,
      message: `Floor ${targetFloorId} has openings but no walls; door/window placement must run after wall generation succeeds.`,
      source_tool: 'detached_house_place_doors_windows',
    });
  }
  if (toolName === 'detached_house_size_members') {
    issues.push(...missingMemberSizeIssues(targetFloorId, columns, beams));
  }
  return issues;
}

function invalidRoomSchemaIds(rooms: Array<Record<string, unknown>>): string[] {
  return rooms.flatMap((room, index) => {
    if (
      typeof room.id === 'string'
      && room.id.trim().length > 0
      && typeof room.type === 'string'
      && room.type.trim().length > 0
      && Array.isArray(room.polygon)
      && room.polygon.length >= 3
    ) {
      return [];
    }
    return [typeof room.id === 'string' && room.id.trim().length > 0 ? room.id : `unknown_room_${index + 1}`];
  });
}

function invalidWallSchemaIds(walls: Array<Record<string, unknown>>): string[] {
  return walls.flatMap((wall, index) => {
    if (
      typeof wall.id === 'string'
      && wall.id.trim().length > 0
      && normalizeLine(wall.line)
      && typeof wall.kind === 'string'
      && ['exterior', 'interior', 'virtual'].includes(wall.kind)
    ) {
      return [];
    }
    return [typeof wall.id === 'string' && wall.id.trim().length > 0 ? wall.id : `unknown_wall_${index + 1}`];
  });
}

function invalidOpeningSchemaIds(openings: Array<Record<string, unknown>>): string[] {
  return openings.flatMap((opening, index) => {
    if (
      typeof opening.id === 'string'
      && opening.id.trim().length > 0
      && (opening.type === 'door' || opening.type === 'window')
      && typeof opening.wall_id === 'string'
      && opening.wall_id.trim().length > 0
    ) {
      return [];
    }
    return [typeof opening.id === 'string' && opening.id.trim().length > 0 ? opening.id : `unknown_opening_${index + 1}`];
  });
}

function invalidColumnSchemaIds(columns: Array<Record<string, unknown>>): string[] {
  return columns.flatMap((column, index) => {
    if (
      typeof column.id === 'string'
      && column.id.trim().length > 0
      && typeof column.x === 'number'
      && typeof column.y === 'number'
    ) {
      return [];
    }
    return [typeof column.id === 'string' && column.id.trim().length > 0 ? column.id : `unknown_column_${index + 1}`];
  });
}

function invalidBeamSchemaIds(beams: Array<Record<string, unknown>>): string[] {
  return beams.flatMap((beam, index) => {
    if (typeof beam.id === 'string' && beam.id.trim().length > 0 && normalizeLine(beam.line)) {
      return [];
    }
    return [typeof beam.id === 'string' && beam.id.trim().length > 0 ? beam.id : `unknown_beam_${index + 1}`];
  });
}

function schemaIssue(
  floorId: string,
  itemName: string,
  elementIds: string[],
  toolName: string,
): Record<string, unknown> {
  return {
    id: `stage_${itemName}_schema_invalid_${floorId}`,
    level: 'error',
    floor_id: floorId,
    message: `Floor ${floorId} has invalid ${itemName} schema: ${elementIds.join(', ')}.`,
    source_tool: toolName,
    element_ids: elementIds,
  };
}

function missingMemberSizeIssues(
  floorId: string,
  columns: Array<Record<string, unknown>>,
  beams: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];
  for (const column of columns) {
    if (typeof column.id !== 'string' || !column.id.trim()) continue;
    if (typeof column.width === 'number' && typeof column.depth === 'number') continue;
    issues.push({
      id: `stage_column_size_missing_${floorId}_${column.id}`,
      level: 'error',
      floor_id: floorId,
      element_id: column.id,
      message: `Column ${column.id} on floor ${floorId} is missing width/depth size.`,
      source_tool: 'detached_house_size_members',
    });
  }
  for (const beam of beams) {
    if (typeof beam.id !== 'string' || !beam.id.trim()) continue;
    if (typeof beam.width === 'number' && typeof beam.height === 'number') continue;
    issues.push({
      id: `stage_beam_size_missing_${floorId}_${beam.id}`,
      level: 'error',
      floor_id: floorId,
      element_id: beam.id,
      message: `Beam ${beam.id} on floor ${floorId} is missing width/height size.`,
      source_tool: 'detached_house_size_members',
    });
  }
  return issues;
}

function buildReplyGuidance(completionStatus: string, targetFloorId: string | undefined): string {
  const scope = targetFloorId ? `for ${targetFloorId}` : 'for the design';
  if (completionStatus === 'needs_attention') {
    return (
      `Summarize only returned artifact data ${scope}. Do not draw an ASCII plan. ` +
      'Do not describe the step as complete. Report targetFloor.issues exactly, including area, region_count, and regions when present.'
    );
  }
  return `Summarize only returned artifact data ${scope}. Do not draw an ASCII plan or invent room positions, dimensions, doors, or windows.`;
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
    .map((floor) => {
      const openings = Array.isArray(floor.openings) ? floor.openings.filter(isRecord) : [];
      const doorCount = openings.filter((opening) => opening.type === 'door').length;
      const windowCount = openings.filter((opening) => opening.type === 'window').length;
      return {
        id: floor.id,
        role: floor.role,
        reference_floor_id: floor.reference_floor_id,
        hasRooms: Array.isArray(floor.rooms) && floor.rooms.length > 0,
        hasWalls: Array.isArray(floor.walls) && floor.walls.length > 0,
        hasOpenings: openings.length > 0,
        openingCount: openings.length,
        doorCount,
        windowCount,
        hasColumns: Array.isArray(floor.columns) && floor.columns.length > 0,
        hasBeams: Array.isArray(floor.beams) && floor.beams.length > 0,
      };
    })
    .filter((floor) => typeof floor.id === 'string' && floor.id.length > 0);
}

function summarizeTargetFloor(
  design: Record<string, unknown>,
  targetFloorId: string | undefined,
  issues: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!targetFloorId) return undefined;
  const floors = Array.isArray(design.floors) ? design.floors.filter(isRecord) : [];
  const floor = floors.find((candidate) => candidate.id === targetFloorId);
  if (!floor) return undefined;

  const rooms = recordArray(floor.rooms);
  const walls = recordArray(floor.walls);
  const openings = recordArray(floor.openings);
  const columns = recordArray(floor.columns);
  const beams = recordArray(floor.beams);
  const doorCount = openings.filter((opening) => opening.type === 'door').length;
  const windowCount = openings.filter((opening) => opening.type === 'window').length;

  return {
    id: floor.id,
    role: floor.role,
    reference_floor_id: floor.reference_floor_id,
    elevation: floor.elevation,
    height: floor.height,
    outline: floor.outline,
    roomCount: rooms.length,
    wallCount: walls.length,
    openingCount: openings.length,
    doorCount,
    windowCount,
    columnCount: columns.length,
    beamCount: beams.length,
    rooms: rooms.slice(0, 30).map(compactRoom),
    walls: walls.slice(0, 60).map(compactWall),
    openings: openings.slice(0, 60).map(compactOpening),
    columns: columns.slice(0, 40).map(compactColumn),
    beams: beams.slice(0, 60).map(compactBeam),
    truncated: {
      rooms: rooms.length > 30,
      walls: walls.length > 60,
      openings: openings.length > 60,
      columns: columns.length > 40,
      beams: beams.length > 60,
    },
    issues: issues.filter((issue) => issueMatchesFloor(issue, targetFloorId)),
  };
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function compactRoom(room: Record<string, unknown>): Record<string, unknown> {
  return {
    id: room.id,
    type: room.type,
    name: room.name,
    polygon: room.polygon,
  };
}

function compactWall(wall: Record<string, unknown>): Record<string, unknown> {
  return {
    id: wall.id,
    kind: wall.kind,
    line: wall.line,
    adjacent_room_ids: wall.adjacent_room_ids,
    thickness: wall.thickness,
    structural: wall.structural,
  };
}

function compactOpening(opening: Record<string, unknown>): Record<string, unknown> {
  return {
    id: opening.id,
    type: opening.type,
    wall_id: opening.wall_id,
    offset: opening.offset,
    width: opening.width,
    height: opening.height,
    room_ids: opening.room_ids,
  };
}

function compactColumn(column: Record<string, unknown>): Record<string, unknown> {
  return {
    id: column.id,
    x: column.x,
    y: column.y,
    size: column.size,
    width: column.width,
    depth: column.depth,
  };
}

function compactBeam(beam: Record<string, unknown>): Record<string, unknown> {
  return {
    id: beam.id,
    line: beam.line,
    start_column_id: beam.start_column_id,
    end_column_id: beam.end_column_id,
    width: beam.width,
    height: beam.height,
  };
}

function normalizeLine(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const line = value.map((item) => Number(item));
  return line.every(Number.isFinite) ? [line[0], line[1], line[2], line[3]] : null;
}

function issueMatchesFloor(issue: Record<string, unknown>, floorId: string): boolean {
  return issue.floor_id === floorId || issue.floorId === floorId || issue.floor === floorId;
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
