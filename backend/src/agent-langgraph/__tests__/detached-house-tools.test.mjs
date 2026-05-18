import { describe, expect, test } from '@jest/globals';
import {
  DETACHED_HOUSE_API_TOOL_IDS,
  createDetachedHouseCreateDesignBasisTool,
  createDetachedHouseBuildAnalysisModelTool,
  createDetachedHouseApiTool,
} from '../../../dist/agent-langgraph/detached-house-tools.js';
import { readDetachedHouseDesign } from '../../../dist/agent-langgraph/detached-house-artifacts.js';

function cfg(state = {}) {
  return {
    configurable: {
      agentState: {
        artifacts: {},
        locale: 'zh',
        ...state,
      },
    },
    toolCall: { id: 'call-1' },
  };
}

describe('detached-house tools', () => {
  test('exposes all external API tool ids', () => {
    expect(DETACHED_HOUSE_API_TOOL_IDS).toEqual([
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
    ]);
  });

  test('API tool description documents stage_requirements options', () => {
    const apiTool = createDetachedHouseApiTool('generate_column_grid', { runTool: async () => ({ design: {}, issues: [] }) });

    expect(apiTool.description).toContain('stage_requirements');
  });

  test('derive global constraints requires a source floor id before calling the API', async () => {
    const setTool = createDetachedHouseCreateDesignBasisTool();
    const setCommand = await setTool.invoke(
      { message: '三层住宅，12m x 9m' },
      cfg(),
    );
    const apiTool = createDetachedHouseApiTool('derive_global_constraints_from_layout', {
      runTool: async () => ({ design: {}, issues: [] }),
    });

    await expect(
      apiTool.invoke(
        { optionsJson: JSON.stringify({}) },
        cfg({ artifacts: setCommand.update.artifacts }),
      ),
    ).rejects.toThrow('requires optionsJson.floor_id');
  });

  test('create design basis parses user intent into detached-house designBasis artifact', async () => {
    const tool = createDetachedHouseCreateDesignBasisTool();
    const command = await tool.invoke(
      {
        message: '设计一个三层独栋住宅，外轮廓 12m x 9m，一层公共活动，二三层卧室。',
        projectName: '自然语言住宅',
      },
      cfg(),
    );

    const design = readDetachedHouseDesign(command.update.artifacts);
    expect(design.project).toEqual({ name: '自然语言住宅', units: 'mm', structure_type: 'rc_frame' });
    expect(design.requirements).toBe('设计一个三层独栋住宅，外轮廓 12m x 9m，一层公共活动，二三层卧室。');
    expect(design.floors).toHaveLength(3);
    expect(design.floors[0].outline).toEqual([[0, 0], [12000, 0], [12000, 9000], [0, 9000]]);
    expect(command.update.messages[0].name).toBe('detached_house_create_design_basis');
    expect(JSON.parse(command.update.messages[0].content).floorIds).toEqual(['F1', 'F2', 'F3']);
  });

  test('API tool reads designBasis and writes updated designBasis', async () => {
    const apiClient = {
      runTool: async (toolId, request) => ({
        design: { ...request.design, touchedBy: toolId },
        issues: [],
      }),
    };
    const setTool = createDetachedHouseCreateDesignBasisTool();
    const setCommand = await setTool.invoke(
      { message: '三层住宅，12m x 9m' },
      cfg(),
    );

    const apiTool = createDetachedHouseApiTool('generate_floor_rooms', apiClient);
    const command = await apiTool.invoke(
      { optionsJson: JSON.stringify({ floor_id: 'F1' }) },
      cfg({ artifacts: setCommand.update.artifacts }),
    );

    expect(command.update.artifacts.designBasis.provenance.floorId).toBe('F1');
    expect(readDetachedHouseDesign(command.update.artifacts)).toEqual({
      version: '0.1',
      project: { name: 'Detached house', units: 'mm', structure_type: 'rc_frame' },
      requirements: '三层住宅，12m x 9m',
      floors: expect.any(Array),
      layout_strategy: { generation_order: ['F1', 'F2', 'F3'] },
      touchedBy: 'generate_floor_rooms',
    });
  });

  test('API tool summary includes opening counts', async () => {
    const apiClient = {
      runTool: async (_toolId, request) => ({
        design: {
          ...request.design,
          floors: [
            {
              ...request.design.floors[0],
              openings: [
                { id: 'D1', type: 'door', wall_id: 'W1' },
                { id: 'W1', type: 'window', wall_id: 'W2' },
              ],
            },
            request.design.floors[1],
          ],
        },
        issues: [],
      }),
    };
    const setTool = createDetachedHouseCreateDesignBasisTool();
    const setCommand = await setTool.invoke(
      { message: '两层住宅，12m x 9m' },
      cfg(),
    );

    const apiTool = createDetachedHouseApiTool('place_doors_windows', apiClient);
    const command = await apiTool.invoke(
      { optionsJson: JSON.stringify({ floor_id: 'F1' }) },
      cfg({ artifacts: setCommand.update.artifacts }),
    );

    const summary = JSON.parse(command.update.messages[0].content);
    expect(summary.floors[0]).toMatchObject({
      id: 'F1',
      hasOpenings: true,
      openingCount: 2,
      doorCount: 1,
      windowCount: 1,
    });
    expect(summary.floors[1]).toMatchObject({
      id: 'F2',
      hasOpenings: false,
      openingCount: 0,
      doorCount: 0,
      windowCount: 0,
    });
  });

  test('API tool summary includes compact target floor artifact detail', async () => {
    const issue = {
      id: 'floor_windows_missing_F1',
      level: 'warning',
      floor_id: 'F1',
      message: 'Floor F1 has no windows.',
    };
    const apiClient = {
      runTool: async (_toolId, request) => ({
        design: {
          ...request.design,
          floors: [
            {
              ...request.design.floors[0],
              rooms: [
                { id: 'R1', type: 'living_room', name: 'Living', polygon: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]] },
              ],
              walls: [
                { id: 'W1', kind: 'exterior', line: [0, 0, 6000, 0], adjacent_room_ids: ['R1', 'OUTSIDE'] },
              ],
              openings: [
                { id: 'D1', type: 'door', wall_id: 'W1', offset: 1000, width: 1000, height: 2100 },
              ],
            },
            request.design.floors[1],
          ],
        },
        issues: [issue],
      }),
    };
    const setTool = createDetachedHouseCreateDesignBasisTool();
    const setCommand = await setTool.invoke(
      { message: '两层住宅，12m x 9m' },
      cfg(),
    );

    const apiTool = createDetachedHouseApiTool('place_doors_windows', apiClient);
    const command = await apiTool.invoke(
      { optionsJson: JSON.stringify({ floor_id: 'F1' }) },
      cfg({ artifacts: setCommand.update.artifacts }),
    );

    const summary = JSON.parse(command.update.messages[0].content);
    expect(summary.completionStatus).toBe('needs_attention');
    expect(summary.targetFloor).toMatchObject({
      id: 'F1',
      roomCount: 1,
      wallCount: 1,
      openingCount: 1,
      doorCount: 1,
      windowCount: 0,
    });
    expect(summary.targetFloor.rooms[0]).toEqual({
      id: 'R1',
      type: 'living_room',
      name: 'Living',
      polygon: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]],
    });
    expect(summary.targetFloor.openings[0]).toMatchObject({ id: 'D1', type: 'door', wall_id: 'W1' });
    expect(summary.targetFloor.issues).toEqual([issue]);
    expect(summary.replyGuidance).toContain('Do not draw an ASCII plan');
    expect(summary.replyGuidance).toContain('Do not describe the step as complete');
  });

  test('API tool rejects invalid floor_id before calling the API', async () => {
    const apiClient = {
      runTool: async () => {
        throw new Error('api should not be called');
      },
    };
    const setTool = createDetachedHouseCreateDesignBasisTool();
    const setCommand = await setTool.invoke(
      { message: '两层住宅', floorsJson: JSON.stringify([{ id: 'L1' }, { id: 'L2' }]) },
      cfg(),
    );

    const apiTool = createDetachedHouseApiTool('generate_floor_rooms', apiClient);

    await expect(apiTool.invoke(
      { optionsJson: JSON.stringify({ floor_id: 'F1' }) },
      cfg({ artifacts: setCommand.update.artifacts }),
    )).rejects.toThrow("Invalid floor_id 'F1' for detached_house_generate_floor_rooms. Available floor_ids: L1, L2");
  });

  test('build analysis model writes state.model and normalizedModel', async () => {
    const design = {
      project: { units: 'mm' },
      floors: [
        { id: 'F1', elevation: 0, height: 3600, columns: [{ id: 'C1', x: 0, y: 0 }], beams: [] },
        { id: 'F2', elevation: 3600, height: 3300, columns: [{ id: 'C1', x: 0, y: 0 }], beams: [] },
      ],
    };
    const setTool = createDetachedHouseCreateDesignBasisTool();
    const setCommand = await setTool.invoke({ message: '两层住宅', floorsJson: JSON.stringify(design.floors) }, cfg());
    const modelTool = createDetachedHouseBuildAnalysisModelTool();
    const command = await modelTool.invoke({}, cfg({ artifacts: setCommand.update.artifacts }));

    expect(command.update.model.schema_version).toBe('2.0.0');
    expect(command.update.artifacts.normalizedModel.payload.schema_version).toBe('2.0.0');
  });
});
