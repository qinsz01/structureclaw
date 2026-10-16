import type { RequestScope } from '../engineering/request-scope.js';
import type { RunPolicyInput, EffectiveRunPolicy } from '../runtime/run-policy.js';
import type { RunUsage } from '../runtime/run-context.js';
import type { AppLocale } from '../shared/locale.js';

export interface AttachmentInfo {
  fileId: string;
  originalName: string;
  relPath: string;
  mimeType?: string;
}

export interface LangGraphRunInput {
  message: string;
  conversationId?: string;
  traceId?: string;
  signal?: AbortSignal;
  context?: {
    runPolicy?: RunPolicyInput;
    requestScope?: RequestScope;
    locale?: AppLocale;
    skillIds?: string[];
    enabledToolIds?: string[];
    disabledToolIds?: string[];
    model?: Record<string, unknown>;
    modelFormat?: string;
    modelRevision?: number;
    analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
    engineId?: string;
    designCode?: string;
    includeReport?: boolean;
    seismicWorkflow?: Record<string, unknown>;
    attachments?: AttachmentInfo[];
    restrictFileAccessToAttachments?: boolean;
  };
}

export interface LangGraphRunResult {
  runPolicy?: EffectiveRunPolicy;
  runUsage?: RunUsage;
  conversationId: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
  success: boolean;
  response: string;
  waitingForReply: boolean;
  question: string | null;
  options: string[];
  mode: 'conversation' | 'execution';
  toolCalls: unknown[];
  model?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  report?: Record<string, unknown>;
  draftState?: Record<string, unknown>;
  presentation?: Record<string, unknown>;
}

export interface AttachmentAnalysis {
  attachment: AttachmentInfo;
  analysis: Record<string, unknown>;
}
