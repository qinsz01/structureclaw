import type { DraftExtraction, DraftState } from '../../../shared/types/agent.js';

export interface FramePatchSources {
  existingState?: DraftState;
  supplementalPatch?: DraftExtraction | null;
  llmPatch?: DraftExtraction | null;
}
