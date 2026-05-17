import { describe, expect, test } from '@jest/globals';
import {
  createDetachedHouseDesignBasisEnvelope,
  createDetachedHouseNormalizedModelEnvelope,
  readDetachedHouseDesign,
} from '../../../dist/agent-langgraph/detached-house-artifacts.js';

describe('detached-house artifacts', () => {
  test('creates and reads designBasis payloads', () => {
    const design = { version: '0.1', floors: [{ id: 'F1' }] };
    const envelope = createDetachedHouseDesignBasisEnvelope({ design, previous: undefined, toolId: 'detached_house_create_design_basis' });

    expect(envelope.kind).toBe('designBasis');
    expect(envelope.schemaVersion).toBe('detached_house_design@0.1');
    expect(envelope.payload).toEqual({ artifactType: 'detached_house_design', design });
    expect(readDetachedHouseDesign({ designBasis: envelope })).toEqual(design);
  });

  test('normalizedModel envelope depends on designBasis', () => {
    const designEnvelope = createDetachedHouseDesignBasisEnvelope({
      design: { floors: [] },
      previous: undefined,
      toolId: 'detached_house_create_design_basis',
    });
    const modelEnvelope = createDetachedHouseNormalizedModelEnvelope({
      model: { schema_version: '2.0.0', nodes: [] },
      designBasis: designEnvelope,
      toolId: 'detached_house_build_analysis_model',
    });

    expect(modelEnvelope.kind).toBe('normalizedModel');
    expect(modelEnvelope.basedOn).toEqual([{ kind: 'designBasis', artifactId: designEnvelope.artifactId, revision: 1 }]);
  });
});
