import { catalogResolvesMissingSectionIssue } from './section-catalog.js';
import { currentDraftDiagnostics } from './draft-diagnostics.js';
import { mergeDraftState } from './draft/boundary.js';
import { invalidDraftFieldsOf, mergeFloorLoadsByStory } from './draft/normalize.js';
import { buildModel } from './model-builder.js';
import {
  computeMissingCriticalKeys,
  computeMissingLoadDetailKeys,
  isDesignDraftField,
} from './draft-guidance.js';
import {
  STRUCTURAL_COORDINATE_SEMANTICS,
  stampDraftSemantics,
} from '../engineering/coordinate-semantics.js';
import type { DraftExtraction, DraftFloorLoad, DraftState, InferredModelType } from '../shared/types/agent.js';

function mergeFloorLoadsWithSupplemental(
  llmFloorLoads: DraftFloorLoad[] | undefined,
  supplementalFloorLoads: DraftFloorLoad[] | undefined,
): DraftFloorLoad[] | undefined {
  if (!llmFloorLoads?.length) {
    return supplementalFloorLoads?.length ? [...supplementalFloorLoads].sort((left, right) => left.story - right.story) : undefined;
  }
  if (!supplementalFloorLoads?.length) {
    return [...llmFloorLoads].sort((left, right) => left.story - right.story);
  }
  return mergeFloorLoadsByStory(supplementalFloorLoads, llmFloorLoads);
}

function mergeSkillStateWithSupplemental(
  llmState: Record<string, unknown> | undefined,
  supplementalState: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!llmState && !supplementalState) {
    return undefined;
  }

  const llmInvalid = llmState?.invalidDraftFields;
  const supplementalInvalid = supplementalState?.invalidDraftFields;
  const invalidDraftFields = Array.isArray(llmInvalid) || Array.isArray(supplementalInvalid)
    ? Array.from(new Set([
      ...(Array.isArray(supplementalInvalid) ? supplementalInvalid : []),
      ...(Array.isArray(llmInvalid) ? llmInvalid : []),
    ].filter((field): field is string => typeof field === 'string')))
    : undefined;

  return {
    ...(supplementalState ?? {}),
    ...(llmState ?? {}),
    ...(invalidDraftFields ? { invalidDraftFields } : {}),
  };
}

export function mergeDraftPatchWithSupplemental(
  llmPatch: DraftExtraction,
  supplementalPatch: DraftExtraction,
): DraftExtraction {
  const nextPatch: DraftExtraction = {};
  const keys = new Set<string>([
    ...Object.keys(supplementalPatch),
    ...Object.keys(llmPatch),
  ]);

  for (const key of keys) {
    if (key === 'floorLoads') {
      nextPatch.floorLoads = mergeFloorLoadsWithSupplemental(llmPatch.floorLoads, supplementalPatch.floorLoads);
      continue;
    }
    if (key === 'skillState') {
      const skillState = mergeSkillStateWithSupplemental(llmPatch.skillState, supplementalPatch.skillState);
      if (skillState !== undefined) {
        nextPatch.skillState = skillState;
      }
      continue;
    }
    const llmValue = llmPatch[key];
    if (llmValue !== undefined) {
      nextPatch[key] = llmValue;
      continue;
    }
    const supplementalValue = supplementalPatch[key];
    if (supplementalValue !== undefined) {
      nextPatch[key] = supplementalValue;
    }
  }

  return nextPatch;
}

export function restrictLegacyDraftPatch(
  patch: DraftExtraction,
  inferredType: InferredModelType,
  allowedKeys: string[],
): DraftExtraction {
  const nextPatch: DraftExtraction = { inferredType };
  if (patch.clearDraftFields !== undefined) nextPatch.clearDraftFields = patch.clearDraftFields;
  if (patch.engineeringDraft !== undefined) {
    nextPatch.engineeringDraft = patch.engineeringDraft;
  }
  if (patch.draftIssues !== undefined) {
    nextPatch.draftIssues = patch.draftIssues;
  }
  for (const key of allowedKeys) {
    if (patch[key] !== undefined) {
      nextPatch[key] = patch[key];
    }
  }
  if (patch.skillState !== undefined) {
    nextPatch.skillState = patch.skillState;
  }
  return nextPatch;
}

export function mergeLegacyState(existing: DraftState | undefined, patch: DraftExtraction, inferredType: InferredModelType, skillId: string): DraftState {
  const merged = mergeDraftState(existing, { ...patch, inferredType });
  return stampDraftSemantics({
    ...merged,
    inferredType,
    skillId,
    structuralTypeKey: (merged.structuralTypeKey ?? skillId) as DraftState['structuralTypeKey'],
    updatedAt: Date.now(),
  });
}

export function computeLegacyMissing(
  state: DraftState,
  phase: 'interactive' | 'execution',
  allowedKeys: string[],
): { critical: string[]; optional: string[] } {
  state = currentDraftDiagnostics(state);
  const allowed = new Set(allowedKeys);
  const critical = computeMissingCriticalKeys(state).filter((key) => allowed.has(key));
  const invalidDraftFields = invalidDraftFieldsOf(state).filter((field) => allowed.has(field));
  const issueFields = Array.isArray(state.draftIssues)
    ? state.draftIssues
      .filter((issue) => !catalogResolvesMissingSectionIssue(state.engineeringDraft, issue))
      .map((issue) => issue.field)
      .filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
    : [];
  for (const field of [...invalidDraftFields, ...issueFields]) {
    if (!critical.includes(field)) {
      critical.push(field);
    }
  }
  if (phase === 'interactive') {
    critical.push(...computeMissingLoadDetailKeys(state).filter((key) => allowed.has(key) && !critical.includes(key)));
  }
  // Missing stability factors, strengths and serviceability limits belong to
  // code-check. Keep the diagnostics without preventing a physically complete solve.
  return { critical: critical.filter((field) => !isDesignDraftField(field)), optional: critical.filter(isDesignDraftField) };
}

export function buildLegacyModel(
  state: DraftState,
  allowedKeys?: string[],
): Record<string, unknown> | undefined {
  const missing = allowedKeys
    ? computeLegacyMissing(state, 'execution', allowedKeys).critical
    : computeMissingCriticalKeys(state);
  if (missing.length > 0) {
    return undefined;
  }
  const model = buildModel(state);
  if (model) {
    const meta = model.metadata as Record<string, unknown>;
    meta.coordinateSemantics = STRUCTURAL_COORDINATE_SEMANTICS;
  }
  return model;
}
