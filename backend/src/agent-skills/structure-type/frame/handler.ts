import { ingestDraft } from '../../../agent-runtime/draft/boundary.js';
import type { SkillHandler } from '../../../shared/types/agent.js';
import { buildFrameDraftPatch, coerceFrameDimension, toFramePatch } from './extract-llm.js';
import {
  buildFrameDefaultProposals,
  buildFrameQuestions,
  buildFrameReportNarrative,
  computeFrameMissing,
  mapFrameLabels,
  resolveFrameStage,
} from './interaction.js';
import { mergeFrameState } from './merge.js';
import { buildFrameModel } from './model.js';
import { normalizeSectionName, normalizeSteelGrade } from '../../../agent-runtime/template-properties.js';

export const handler: SkillHandler = {

  parseProvidedValues(values) {
    const base = coerceFrameDimension(
      toFramePatch(ingestDraft(values)),
      undefined,
    );
    return {
      ...base,
      ...(typeof values.frameMaterial === 'string' && { frameMaterial: normalizeSteelGrade(values.frameMaterial) }),
      ...(typeof values.frameColumnSection === 'string' && { frameColumnSection: normalizeSectionName(values.frameColumnSection) }),
      ...(typeof values.frameBeamSection === 'string' && { frameBeamSection: normalizeSectionName(values.frameBeamSection) }),
    };
  },

  extractDraft({ llmDraftPatch, currentState, locale }) {
    return buildFrameDraftPatch(llmDraftPatch, currentState, locale);
  },

  mergeState(existing, patch) {
    return mergeFrameState(existing, patch);
  },

  computeMissing(state, phase) {
    return computeFrameMissing(state, phase);
  },

  mapLabels(keys, locale) {
    return mapFrameLabels(keys, locale);
  },

  buildQuestions(keys, criticalMissing, state, locale) {
    return buildFrameQuestions(keys, criticalMissing, state, locale);
  },

  buildDefaultProposals(keys, state, locale) {
    return buildFrameDefaultProposals(keys, state, locale);
  },

  buildReportNarrative(input) {
    return buildFrameReportNarrative(input);
  },

  buildModel(state) {
    if (computeFrameMissing(state, 'execution').critical.length > 0) {
      return undefined;
    }
    return buildFrameModel(state);
  },

  resolveStage(missingKeys) {
    return resolveFrameStage(missingKeys);
  },
};

export default handler;
