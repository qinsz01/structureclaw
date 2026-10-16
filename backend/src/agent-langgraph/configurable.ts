/**
 * Dependency injection container for the LangGraph agent.
 *
 * Passed via config.configurable so tools and nodes can access
 * shared services without globalThis globals.
 */
import type { AgentSkillRuntime } from '../agent-runtime/index.js';
import type { LocalAnalysisEngineClient } from '../agent-skills/analysis/types.js';
import type { CodeCheckClient } from '../agent-skills/code-check/rule.js';
import type { LocalStructureProtocolClient } from '../skill-shared/structure-protocol-execution.js';
import type { beginAnalysisRequest, beginNativeDesignRequest } from '../engineering/model-state.js';
import type { RunContext } from '../runtime/run-context.js';
import type { ToolContext } from './tool-context.js';

export interface AgentConfigurable {
  runContext?: RunContext;
  /** Skill runtime for structural engineering operations. */
  skillRuntime: AgentSkillRuntime;
  /** Analysis engine client (OpenSees, etc.). */
  engineClient: LocalAnalysisEngineClient;
  /** Code check client. */
  codeCheckClient: CodeCheckClient;
  /** Structure protocol client (validation). */
  structureProtocolClient: LocalStructureProtocolClient;
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Request-level file paths that analyze_file may read; the checkpointed allow-list takes precedence. */
  fileAccessAllowlist?: string[];
  /** Whether shell-risk tools may be activated for this run. */
  allowShell: boolean;
  /**
   * Tool exposure, skill scope, budget and file allow-list for the current node, derived from the
   * turn's frozen run policy (`deriveToolContext`). Set by the host on a per-node config copy.
   */
  toolContext?: ToolContext;
  /** Reserve the request before solver I/O, including on failures and cancellation. */
  onAnalysisRequest?: (update: ReturnType<typeof beginAnalysisRequest> | ReturnType<typeof beginNativeDesignRequest>['update']) => void;
  summarizeFileImages?: (analysis: Record<string, unknown>, filePath: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
}
