import { genericMissing, genericQuestions } from '../../../agent-runtime/generic-readiness.js';
import { ingestGenericDraft, mergeGenericDraftState } from '../../../agent-runtime/draft/boundary.js';
import { buildStructuralTypeMatch } from '../../../agent-runtime/plugin-helpers.js';
import { buildGenericReportNarrative } from './report.js';
import type {
  SkillHandler,
  SkillReportNarrativeInput,
} from '../../../shared/types/agent.js';

export const handler: SkillHandler = {
  // Whether a message is a structural request is the agent's and the LLM router's decision; the
  // generic skill is the advisory fallback whenever no specific skill matches.
  detectStructuralType({ locale, currentState }) {
    if (currentState?.skillId === 'generic') {
      return buildStructuralTypeMatch(
        currentState.structuralTypeKey ?? 'unknown',
        currentState.inferredType,
        'generic',
        currentState.supportLevel ?? 'fallback',
        locale,
        {
          zh: '继续使用通用结构类型 skill 处理当前对话。',
          en: 'Continue using the generic structure-type skill for the current conversation.',
        },
        'current-state',
      );
    }

    return buildStructuralTypeMatch('unknown', 'unknown', 'generic', 'fallback', locale, {
      zh: '已切换到通用结构类型 skill，先接住当前问题并继续补参。',
      en: 'Switched to the generic structure-type skill to catch the request and continue clarification.',
    }, 'generic-fallback');
  },

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
