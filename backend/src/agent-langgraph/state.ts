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
  ProviderBindingState,
} from '../agent-runtime/types.js';
import type { AppLocale } from '../services/locale.js';
import type { AnalysisRequestBinding, ModelTransaction } from '../engineering/model-state.js';
import { mergeInputEvidence } from '../engineering/input-evidence.js';

export interface AgentToolAccessPolicy {
  enabledToolIds: string[] | null;
  disabledToolIds: string[] | null;
  fileAccessAllowlist: string[] | null;
}

/** Per-session agent state persisted via the LangGraph checkpointer. */
export interface AgentSessionState {
  /** Accumulated structural draft parameters. */
  draftState: DraftState | null;
  /** Pipeline artifact envelopes keyed by kind. */
  artifacts: AgentArtifactState;
  /** Currently selected skill IDs (user-chosen or auto-detected). */
  selectedSkillIds: string[];
  /** Tool and attachment access policy retained across clarification interrupts. */
  toolAccessPolicy: AgentToolAccessPolicy;
  /** User locale (zh / en). */
  locale: AppLocale;
  /** Absolute path of the workspace root directory. */
  workspaceRoot: string;
  /** Pipeline execution policy for the current project. */
  policy: AgentExecutionPolicy;
  /** Structured seismic workflow passed from request context for the current turn. */
  contextSeismicWorkflow: Record<string, unknown> | null;
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
    toolAccessPolicy: {
      enabledToolIds: null,
      disabledToolIds: null,
      fileAccessAllowlist: null,
    },
    locale: 'zh',
    workspaceRoot: '',
    policy: {},
    contextSeismicWorkflow: null,
    bindings: {},
    lastUserMessage: '',
    structuralTypeKey: null,
    ...overrides,
  };
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
    reducer: (prev, next) => ({ ...(prev ?? {}), ...next }),
    default: () => ({}),
  }),
  selectedSkillIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  toolAccessPolicy: Annotation<AgentToolAccessPolicy>({
    reducer: (_prev, next) => next,
    default: () => ({
      enabledToolIds: null,
      disabledToolIds: null,
      fileAccessAllowlist: null,
    }),
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
    reducer: (prev, next) => ({ ...prev, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) }),
    default: () => ({}),
  }),
  contextSeismicWorkflow: Annotation<Record<string, unknown> | null>({
    reducer: (_prev, next) => next,
    default: () => null,
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
  modelRevision: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  modelPending: Annotation<boolean>({ reducer: (_prev, next) => next, default: () => false }),
  modelHistory: Annotation<ModelTransaction[]>({ reducer: (_prev, next) => next, default: () => [] }),
  analysisRequestSequence: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  analysisRequest: Annotation<AnalysisRequestBinding | null>({ reducer: (_prev, next) => next, default: () => null }),
  resultQuantities: Annotation<Record<string, Record<string, unknown>>>({
    reducer: (prev, next) => ({ ...prev, ...next }), default: () => ({}),
  }),
  inputEvidence: Annotation<Record<string, unknown>[]>({
    reducer: (prev, next) => mergeInputEvidence(prev, next) ?? [], default: () => [],
  }),
  analysisRuns: Annotation<Record<string, Record<string, unknown>>>({
    reducer: (prev, next) => ({ ...prev, ...next }), default: () => ({}),
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
