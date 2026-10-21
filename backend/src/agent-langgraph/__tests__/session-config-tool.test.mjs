import { describe, expect, test } from '@jest/globals';
import { createSetSessionConfigTool } from '../../../dist/agent-langgraph/tools.js';

const invoke = input => createSetSessionConfigTool().invoke(input, { toolCall: { id: 'session' }, configurable: {
  agentState: { policy: {}, selectedSkillIds: ['generic'] } } });

describe('session config tool', () => {
  test('seismic configuration migrates legacy providers without auto-enabling structure skills', async () => {
    const command = await invoke({ analysisType: 'seismic', designCode: 'GB/T 50011-2010-2024',
      skillIdsJson: JSON.stringify(['concrete-frame', 'opensees-seismic', 'validation-structure-model', 'report-export-builtin']) });
    expect(command.update.selectedSkillIds).toEqual(['concrete-frame']);
    expect(command.update.policy).toMatchObject({ analysisType: 'seismic', designCode: 'GB/T 50011-2010-2024', analysisProviderPreference: 'opensees-seismic' });
  });
  test('provider-only selection preserves existing structure scope', async () => {
    const command = await invoke({ skillIdsJson: '["opensees-static"]' });
    expect(command.update.selectedSkillIds).toBeUndefined();
    expect(command.update.policy.analysisProviderPreference).toBe('opensees-static');
  });
  test('changing analysis type alone does not alter skills', async () => {
    const command = await invoke({ analysisType: 'seismic' });
    expect(command.update.selectedSkillIds).toBeUndefined();
    expect(command.update.policy.analysisType).toBe('seismic');
  });
  test('invalid non-structure ids are rejected clearly', async () => {
    const command = await invoke({ skillIdsJson: '["not-a-skill"]' });
    expect(JSON.parse(command.update.messages[0].content).error_code).toBe('INVALID_SKILL_IDS');
  });
});
