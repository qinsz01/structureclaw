import crypto from 'node:crypto';
import type { AgentArtifactState, ArtifactEnvelope } from '../agent-runtime/types.js';
import { computeDependencyFingerprint } from '../agent-runtime/artifact-helpers.js';

export interface DetachedHouseDesignBasisPayload {
  artifactType: 'detached_house_design';
  design: Record<string, unknown>;
}

export function readDetachedHouseDesign(artifacts: AgentArtifactState | undefined): Record<string, unknown> | null {
  const payload = artifacts?.designBasis?.payload as Partial<DetachedHouseDesignBasisPayload> | undefined;
  if (payload?.artifactType !== 'detached_house_design') return null;
  return isRecord(payload.design) ? payload.design : null;
}

export function createDetachedHouseDesignBasisEnvelope(args: {
  design: Record<string, unknown>;
  previous?: ArtifactEnvelope;
  toolId: string;
  floorId?: string;
  referenceFloorId?: string;
}): ArtifactEnvelope<DetachedHouseDesignBasisPayload> {
  const now = Date.now();
  return {
    artifactId: args.previous?.artifactId ?? `detached-house-design-${shortHash(args.design)}`,
    kind: 'designBasis',
    scope: 'session',
    status: 'ready',
    revision: (args.previous?.revision ?? 0) + 1,
    createdAt: args.previous?.createdAt ?? now,
    updatedAt: now,
    basedOn: args.previous ? [{ kind: 'designBasis', artifactId: args.previous.artifactId, revision: args.previous.revision }] : [],
    dependencyFingerprint: shortHash(args.design),
    schemaVersion: 'detached_house_design@0.1',
    provenance: {
      toolId: args.toolId,
      ...(args.floorId ? { floorId: args.floorId } : {}),
      ...(args.referenceFloorId ? { referenceFloorId: args.referenceFloorId } : {}),
    },
    payload: { artifactType: 'detached_house_design', design: args.design },
  };
}

export function createDetachedHouseNormalizedModelEnvelope(args: {
  model: Record<string, unknown>;
  designBasis: ArtifactEnvelope;
  toolId: string;
}): ArtifactEnvelope<Record<string, unknown>> {
  const now = Date.now();
  return {
    artifactId: `detached-house-model-${shortHash(args.model)}`,
    kind: 'normalizedModel',
    scope: 'session',
    status: 'ready',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    basedOn: [{ kind: 'designBasis', artifactId: args.designBasis.artifactId, revision: args.designBasis.revision }],
    dependencyFingerprint: computeDependencyFingerprint({
      designBasis: { artifactId: args.designBasis.artifactId, revision: args.designBasis.revision },
    }),
    schemaVersion: '2.0.0',
    provenance: { toolId: args.toolId },
    payload: args.model,
  };
}

function shortHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableNormalize(value))).digest('hex').slice(0, 12);
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableNormalize(value[key])]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
