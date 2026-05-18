import { describe, expect, test } from '@jest/globals';

const GUIDANCE_MARKER = 'DETACHED_HOUSE_WORKFLOW_GUIDANCE';

function makeDetachedHouseManifest() {
  return {
    id: 'detached-house-design',
    domain: 'design',
    structureType: 'unknown',
    structuralTypeKeys: [],
    name: { zh: '独立住宅设计', en: 'Detached House Design' },
    description: {
      zh: '用于独立住宅、独栋住宅、别墅等多层住宅建筑结构方案设计。',
      en: 'Use for detached-house and single-family residential building-structure design.',
    },
    triggers: ['detached house', 'single-family house', '独立住宅', '独栋住宅', '别墅'],
    stages: ['intent', 'design'],
    capabilities: ['detached-house-workflow', 'prompt-guidance'],
    requires: [],
    conflicts: [],
    supportedAnalysisTypes: [],
    supportedModelFamilies: [],
    materialFamilies: [],
    priority: 80,
    compatibility: { minRuntimeVersion: '0.1.0', skillApiVersion: 'v1' },
    runtimeContract: {
      role: 'assistant',
      consumes: [],
      provides: ['designBasis', 'normalizedModel'],
    },
  };
}

function makeDetachedHouseBundle() {
  return {
    ...makeDetachedHouseManifest(),
    markdownByStage: {
      intent: 'Use this skill when the user asks for detached-house design.',
      design: `${GUIDANCE_MARKER}\nCall detached-house tools one floor at a time and follow the user-priority floor order.`,
    },
  };
}

function messageContent(messages) {
  return String(messages[0]?.content ?? '');
}

describe('detached-house skill prompt guidance', () => {
  test('global system prompt does not hard-code the detached-house workflow', async () => {
    const { buildSystemMessages } = await import('../../../dist/agent-langgraph/system-prompt.js');
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const content = messageContent(buildSystemMessages({
      state: emptySessionState({ locale: 'zh' }),
      skillManifests: [makeDetachedHouseManifest()],
      skillBundles: [makeDetachedHouseBundle()],
    }));

    expect(content).not.toContain('detached_house_generate_floor_rooms（标准层）');
    expect(content).not.toContain('detached_house_propagate_floor_rooms（相似楼层）');
    expect(content).not.toContain('for the standard floor');
    expect(content).not.toContain(GUIDANCE_MARKER);
  });

  test('injects detached-house guidance when the user message matches the skill triggers', async () => {
    const { buildSystemMessages } = await import('../../../dist/agent-langgraph/system-prompt.js');
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const content = messageContent(buildSystemMessages({
      state: emptySessionState({
        locale: 'zh',
        lastUserMessage: '我想先设计一栋三层独栋住宅，先从首层户型开始。',
      }),
      skillManifests: [makeDetachedHouseManifest()],
      skillBundles: [makeDetachedHouseBundle()],
    }));

    expect(content).toContain('detached-house-design');
    expect(content).toContain(GUIDANCE_MARKER);
  });

  test('injects detached-house guidance for follow-up turns with a detached-house artifact', async () => {
    const { buildSystemMessages } = await import('../../../dist/agent-langgraph/system-prompt.js');
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const content = messageContent(buildSystemMessages({
      state: emptySessionState({
        locale: 'zh',
        lastUserMessage: '继续生成门窗。',
        artifacts: {
          designBasis: {
            artifactId: 'detached-house-design-test',
            kind: 'designBasis',
            scope: 'session',
            status: 'ready',
            revision: 3,
            createdAt: 1,
            updatedAt: 2,
            basedOn: [],
            dependencyFingerprint: 'test',
            schemaVersion: 'detached_house_design@0.1',
            provenance: { toolId: 'detached_house_generate_floor_walls' },
            payload: { artifactType: 'detached_house_design', design: { floors: [] } },
          },
        },
      }),
      skillManifests: [makeDetachedHouseManifest()],
      skillBundles: [makeDetachedHouseBundle()],
    }));

    expect(content).toContain('detached-house-design');
    expect(content).toContain(GUIDANCE_MARKER);
  });

  test('builtin detached-house skill is discoverable and carries prompt guidance markdown', async () => {
    const { AgentSkillRuntime } = await import('../../../dist/agent-runtime/index.js');
    const runtime = new AgentSkillRuntime();

    const manifests = await runtime.listSkillManifests();
    const bundles = runtime.listSkills();
    const manifest = manifests.find((skill) => skill.id === 'detached-house-design');
    const bundle = bundles.find((skill) => skill.id === 'detached-house-design');

    expect(manifest).toBeDefined();
    expect(manifest.capabilities).toContain('prompt-guidance');
    expect(bundle).toBeDefined();
    expect(bundle.markdownByStage.design).toContain(GUIDANCE_MARKER);
    expect(bundle.markdownByStage.design).toContain('Call at most one state-mutating detached_house_* tool');
    expect(bundle.markdownByStage.design).toContain('optionsJson.stage_requirements');
    expect(bundle.markdownByStage.design).toContain('targetFloor');
    expect(bundle.markdownByStage.design).toContain('Do not invent ASCII plans');
  });
});
