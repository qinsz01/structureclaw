import { describe, expect, test } from '@jest/globals';
import {
  DETACHED_HOUSE_API_TOOL_IDS,
  createDetachedHouseSetDesignBasisTool,
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

  test('set design basis writes detached-house designBasis artifact', async () => {
    const tool = createDetachedHouseSetDesignBasisTool();
    const command = await tool.invoke(
      { designJson: JSON.stringify({ floors: [{ id: 'F1' }] }) },
      cfg(),
    );

    expect(readDetachedHouseDesign(command.update.artifacts)).toEqual({ floors: [{ id: 'F1' }] });
    expect(command.update.messages[0].name).toBe('detached_house_set_design_basis');
    expect(JSON.parse(command.update.messages[0].content).floorIds).toEqual(['F1']);
  });

  test('API tool reads designBasis and writes updated designBasis', async () => {
    const apiClient = {
      runTool: async (toolId, request) => ({
        design: { ...request.design, touchedBy: toolId },
        issues: [],
      }),
    };
    const setTool = createDetachedHouseSetDesignBasisTool();
    const setCommand = await setTool.invoke(
      { designJson: JSON.stringify({ floors: [{ id: 'F1' }] }) },
      cfg(),
    );

    const apiTool = createDetachedHouseApiTool('generate_floor_rooms', apiClient);
    const command = await apiTool.invoke(
      { optionsJson: JSON.stringify({ floor_id: 'F1' }) },
      cfg({ artifacts: setCommand.update.artifacts }),
    );

    expect(readDetachedHouseDesign(command.update.artifacts)).toEqual({
      floors: [{ id: 'F1' }],
      touchedBy: 'generate_floor_rooms',
    });
  });

  test('API tool rejects invalid floor_id before calling the API', async () => {
    const apiClient = {
      runTool: async () => {
        throw new Error('api should not be called');
      },
    };
    const setTool = createDetachedHouseSetDesignBasisTool();
    const setCommand = await setTool.invoke(
      { designJson: JSON.stringify({ floors: [{ id: 'L1' }, { id: 'L2' }] }) },
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
    const setTool = createDetachedHouseSetDesignBasisTool();
    const setCommand = await setTool.invoke({ designJson: JSON.stringify(design) }, cfg());
    const modelTool = createDetachedHouseBuildAnalysisModelTool();
    const command = await modelTool.invoke({}, cfg({ artifacts: setCommand.update.artifacts }));

    expect(command.update.model.schema_version).toBe('2.0.0');
    expect(command.update.artifacts.normalizedModel.payload.schema_version).toBe('2.0.0');
  });
});
