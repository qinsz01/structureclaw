/**
 * LangGraph agent state annotation for StructureClaw.
 *
 * Extends LangGraph's message-based state with domain-specific fields
 * (draft state, pipeline artifacts, skill selection, locale, workspace).
 */
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  DraftState,
  AgentArtifactState,
  AgentExecutionPolicy,
  ArtifactEnvelope,
  ArtifactRef,
  ProviderBindingState,
} from '../agent-runtime/types.js';
import type { AppLocale } from '../services/locale.js';

/** Per-session agent state persisted via the LangGraph checkpointer. */
export interface AgentSessionState {
  /** Accumulated structural draft parameters. */
  draftState: DraftState | null;
  /** Pipeline artifact envelopes keyed by kind. */
  artifacts: AgentArtifactState;
  /** Currently selected skill IDs (user-chosen or auto-detected). */
  selectedSkillIds: string[];
  /** User locale (zh / en). */
  locale: AppLocale;
  /** Absolute path of the workspace root directory. */
  workspaceRoot: string;
  /** Pipeline execution policy for the current project. */
  policy: AgentExecutionPolicy;
  /** Provider skill bindings. */
  bindings: ProviderBindingState;
  /** Last user message (for context in tool calls). */
  lastUserMessage: string;
  /** Structural type match from last detection. */
  structuralTypeKey: string | null;
}

/** Helper to produce a blank initial session state. */
export function emptySessionState(overrides?: Partial<AgentSessionState>): AgentSessionState {
  return {
    draftState: null,
    artifacts: {},
    selectedSkillIds: [],
    locale: 'zh',
    workspaceRoot: '',
    policy: {},
    bindings: {},
    lastUserMessage: '',
    structuralTypeKey: null,
    ...overrides,
  };
}

export function mergeAgentArtifacts(
  prev: AgentArtifactState | undefined,
  next: AgentArtifactState | undefined,
): AgentArtifactState {
  const merged: AgentArtifactState = { ...(prev ?? {}), ...(next ?? {}) };
  if (prev?.designBasis && next?.designBasis) {
    merged.designBasis = mergeDetachedHouseDesignBasis(prev.designBasis, next.designBasis);
  }
  return merged;
}

function mergeDetachedHouseDesignBasis(
  prev: ArtifactEnvelope,
  next: ArtifactEnvelope,
): ArtifactEnvelope {
  if (!isDetachedHouseEnvelope(prev) || !isDetachedHouseEnvelope(next)) {
    return next;
  }
  if (isBasedOn(next, prev)) {
    return next;
  }
  if (!hasSameDirectBase(prev, next)) {
    return next;
  }

  const nextFloorId = next.provenance.floorId;
  if (!nextFloorId) {
    return next;
  }

  const mergedDesign = mergeDetachedHouseFloor(
    prev.payload.design,
    next.payload.design,
    nextFloorId,
  );
  if (!mergedDesign) {
    return next;
  }

  const mergedFloorIds = [
    ...new Set([
      ...(prev.provenance.mergedFloorIds ?? []),
      ...(prev.provenance.floorId ? [prev.provenance.floorId] : []),
      ...(next.provenance.mergedFloorIds ?? []),
      nextFloorId,
    ]),
  ];

  return {
    ...prev,
    revision: Math.max(prev.revision, next.revision),
    updatedAt: Math.max(prev.updatedAt, next.updatedAt),
    dependencyFingerprint: `${prev.dependencyFingerprint}+${next.dependencyFingerprint}`,
    provenance: {
      ...prev.provenance,
      toolId: next.provenance.toolId ?? prev.provenance.toolId,
      mergedFloorIds,
    },
    payload: {
      ...prev.payload,
      design: mergedDesign,
    },
  };
}

function isDetachedHouseEnvelope(
  envelope: ArtifactEnvelope,
): envelope is ArtifactEnvelope<{ artifactType: 'detached_house_design'; design: Record<string, unknown> }> {
  const payload = envelope.payload;
  return (
    isRecord(payload) &&
    payload.artifactType === 'detached_house_design' &&
    isRecord(payload.design)
  );
}

function isBasedOn(envelope: ArtifactEnvelope, base: ArtifactEnvelope): boolean {
  return envelope.basedOn.some((ref) => artifactRefMatchesEnvelope(ref, base));
}

function hasSameDirectBase(left: ArtifactEnvelope, right: ArtifactEnvelope): boolean {
  const leftBase = left.basedOn[0];
  const rightBase = right.basedOn[0];
  if (!leftBase || !rightBase) return false;
  return artifactRefsEqual(leftBase, rightBase);
}

function artifactRefMatchesEnvelope(ref: ArtifactRef, envelope: ArtifactEnvelope): boolean {
  return ref.kind === envelope.kind && ref.artifactId === envelope.artifactId && ref.revision === envelope.revision;
}

function artifactRefsEqual(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.kind === right.kind && left.artifactId === right.artifactId && left.revision === right.revision;
}

function mergeDetachedHouseFloor(
  prevDesign: Record<string, unknown>,
  nextDesign: Record<string, unknown>,
  floorId: string,
): Record<string, unknown> | null {
  const nextFloors = Array.isArray(nextDesign.floors) ? nextDesign.floors : [];
  const nextFloor = nextFloors.find((floor) => isRecord(floor) && floor.id === floorId);
  if (!isRecord(nextFloor)) return null;

  const prevClone = cloneRecord(prevDesign);
  const prevFloors = Array.isArray(prevClone.floors) ? [...prevClone.floors] : [];
  const floorIndex = prevFloors.findIndex((floor) => isRecord(floor) && floor.id === floorId);
  if (floorIndex >= 0) {
    prevFloors[floorIndex] = cloneValue(nextFloor);
  } else {
    prevFloors.push(cloneValue(nextFloor));
  }
  prevClone.floors = prevFloors;
  return prevClone;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneValue(value) as Record<string, unknown>;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * LangGraph state annotation.
 *
 * `messages` uses the built-in messagesStateReducer which handles
 * merging, deduplication, and removal correctly.
 * All domain fields use a last-writer-wins (replace) reducer.
 */
export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  draftState: Annotation<DraftState | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  artifacts: Annotation<AgentArtifactState>({
    reducer: mergeAgentArtifacts,
    default: () => ({}),
  }),
  selectedSkillIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  locale: Annotation<AppLocale>({
    reducer: (_prev, next) => next,
    default: () => 'zh',
  }),
  workspaceRoot: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  policy: Annotation<AgentExecutionPolicy>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),
  bindings: Annotation<ProviderBindingState>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),
  lastUserMessage: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  structuralTypeKey: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Built structural model (written by build_model tool via Command). */
  model: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Analysis results (written by run_analysis tool via Command). */
  analysisResult: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Code check results (written by run_code_check tool via Command). */
  codeCheckResult: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Generated report (written by generate_report tool via Command). */
  report: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

/** Inferred TypeScript type from the annotation. */
export type AgentState = typeof AgentStateAnnotation.State;
