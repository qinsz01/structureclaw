import { describe, expect, test } from '@jest/globals';

describe('AgentSessionState: emptySessionState', () => {
  test('returns correct default values', async () => {
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const state = emptySessionState();
    expect(state.draftState).toBeNull();
    expect(state.artifacts).toEqual({});
    expect(state.selectedSkillIds).toEqual([]);
    expect(state.locale).toBe('zh');
    expect(state.workspaceRoot).toBe('');
    expect(state.policy).toEqual({});
    expect(state.bindings).toEqual({});
    expect(state.lastUserMessage).toBe('');
    expect(state.structuralTypeKey).toBeNull();
  });

  test('applies overrides', async () => {
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const state = emptySessionState({ locale: 'en', workspaceRoot: '/tmp/workspace' });
    expect(state.locale).toBe('en');
    expect(state.workspaceRoot).toBe('/tmp/workspace');
    // Unoverridden fields remain at defaults
    expect(state.draftState).toBeNull();
    expect(state.selectedSkillIds).toEqual([]);
  });

  test('does not share mutable default values between instances', async () => {
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const a = emptySessionState();
    const b = emptySessionState();
    a.selectedSkillIds.push('frame');
    expect(b.selectedSkillIds).toEqual([]);
    a.artifacts['model'] = { kind: 'model' };
    expect(b.artifacts).toEqual({});
  });

  test('partial overrides: only specified fields change', async () => {
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const draft = { inferredType: 'beam', skillId: 'simple-beam' };
    const state = emptySessionState({ draftState: draft, selectedSkillIds: ['simple-beam'] });
    expect(state.draftState).toBe(draft);
    expect(state.selectedSkillIds).toEqual(['simple-beam']);
    expect(state.locale).toBe('zh');
    expect(state.workspaceRoot).toBe('');
  });

  test('policy and bindings default to empty objects', async () => {
    const { emptySessionState } = await import('../../../dist/agent-langgraph/state.js');

    const state = emptySessionState();
    expect(Object.keys(state.policy)).toHaveLength(0);
    expect(Object.keys(state.bindings)).toHaveLength(0);
  });
});

describe('AgentStateAnnotation: schema shape', () => {
  test('annotation exports AgentStateAnnotation with expected channel keys', async () => {
    const { AgentStateAnnotation } = await import('../../../dist/agent-langgraph/state.js');

    const expectedKeys = [
      'messages', 'draftState', 'artifacts', 'selectedSkillIds',
      'locale', 'workspaceRoot', 'policy', 'bindings',
      'lastUserMessage', 'structuralTypeKey',
      'model', 'analysisResult', 'codeCheckResult', 'report',
    ];
    for (const key of expectedKeys) {
      expect(AgentStateAnnotation.spec).toHaveProperty(key);
    }
  });

  test('annotation spec channels are LangGraph channel objects', async () => {
    const { AgentStateAnnotation } = await import('../../../dist/agent-langgraph/state.js');

    // LangGraph BinaryOperatorAggregate / LastValue channels expose a getValue method
    // or at minimum are non-null objects
    for (const [key, channel] of Object.entries(AgentStateAnnotation.spec)) {
      expect(channel).not.toBeNull();
      expect(typeof channel).toBe('object');
      expect(channel.lc_graph_name).toBeDefined();
    }
  });
});

describe('mergeAgentArtifacts: detached-house floor updates', () => {
  function makeEnvelope({ revision, basedOn = [], floorId, floors }) {
    return {
      artifactId: 'detached-house-design-1',
      kind: 'designBasis',
      scope: 'session',
      status: 'ready',
      revision,
      createdAt: 1,
      updatedAt: revision,
      basedOn,
      dependencyFingerprint: `rev-${revision}-${floorId ?? 'global'}`,
      schemaVersion: 'detached_house_design@0.1',
      provenance: {
        toolId: 'detached_house_generate_floor_walls',
        ...(floorId ? { floorId } : {}),
      },
      payload: {
        artifactType: 'detached_house_design',
        design: { floors },
      },
    };
  }

  test('merges sibling floor-specific detached-house updates from the same base revision', async () => {
    const { mergeAgentArtifacts } = await import('../../../dist/agent-langgraph/state.js');
    const baseRef = { kind: 'designBasis', artifactId: 'detached-house-design-1', revision: 1 };
    const f1Update = makeEnvelope({
      revision: 2,
      basedOn: [baseRef],
      floorId: 'F1',
      floors: [
        { id: 'F1', walls: [{ id: 'F1_W1' }] },
        { id: 'F2' },
      ],
    });
    const f2Update = makeEnvelope({
      revision: 2,
      basedOn: [baseRef],
      floorId: 'F2',
      floors: [
        { id: 'F1' },
        { id: 'F2', walls: [{ id: 'F2_W1' }] },
      ],
    });

    const merged = mergeAgentArtifacts(
      { designBasis: f1Update },
      { designBasis: f2Update },
    );

    expect(merged.designBasis.payload.design.floors).toEqual([
      { id: 'F1', walls: [{ id: 'F1_W1' }] },
      { id: 'F2', walls: [{ id: 'F2_W1' }] },
    ]);
    expect(merged.designBasis.provenance.mergedFloorIds).toEqual(['F1', 'F2']);
  });

  test('keeps sequential detached-house updates as replace semantics', async () => {
    const { mergeAgentArtifacts } = await import('../../../dist/agent-langgraph/state.js');
    const f1Update = makeEnvelope({
      revision: 2,
      basedOn: [{ kind: 'designBasis', artifactId: 'detached-house-design-1', revision: 1 }],
      floorId: 'F1',
      floors: [
        { id: 'F1', walls: [{ id: 'F1_W1' }] },
        { id: 'F2' },
      ],
    });
    const sequentialUpdate = makeEnvelope({
      revision: 3,
      basedOn: [{ kind: 'designBasis', artifactId: 'detached-house-design-1', revision: 2 }],
      floorId: 'F2',
      floors: [
        { id: 'F1', walls: [{ id: 'F1_W1' }] },
        { id: 'F2', walls: [{ id: 'F2_W1' }] },
      ],
    });

    const merged = mergeAgentArtifacts(
      { designBasis: f1Update },
      { designBasis: sequentialUpdate },
    );

    expect(merged.designBasis).toEqual(sequentialUpdate);
  });
});
