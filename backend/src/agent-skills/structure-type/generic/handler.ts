import { genericMissing, genericQuestions } from '../../../agent-runtime/generic-readiness.js';
import { ingestGenericDraft, mergeGenericDraftState } from '../../../agent-runtime/draft/boundary.js';
import { buildGenericReportNarrative } from './report.js';
import type {
  SkillHandler,
  SkillReportNarrativeInput,
} from '../../../shared/types/agent.js';

export const handler: SkillHandler = {

  parseProvidedValues(values) {
    return ingestGenericDraft(values);
  },

  extractDraft({ llmDraftPatch, currentState, message }) {
    return ingestGenericDraft(llmDraftPatch, currentState, message);
  },

  mergeState(existing, patch) {
    return mergeGenericDraftState(existing, patch);
  },

  computeMissing(state) {
    return { critical: genericMissing(state), optional: [] };
  },

  mapLabels(keys, locale) {
    return genericQuestions(keys, undefined, locale).map(question => question.label);
  },

  buildQuestions(keys, _criticalMissing, state, locale) {
    return genericQuestions(keys, state, locale);
  },

  buildDefaultProposals() {
    return [];
  },

  buildReportNarrative(input: SkillReportNarrativeInput) {
    return buildGenericReportNarrative(input);
  },

  buildModel() {
    return undefined;
  },

  resolveStage(_missingKeys, state) {
    return genericMissing(state).length ? 'intent' : 'model';
  },
};

export default handler;
