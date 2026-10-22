import { describe, expect, jest, test } from '@jest/globals';
import { HumanMessage } from '@langchain/core/messages';
import { normalizeMemberReleases, MemberReleaseValidationError } from '../dist/engineering/member-releases.js';
import { normalizeEngineeringDraft, mergeEngineeringDraft } from '../dist/agent-runtime/engineering-draft.js';
import { ingestGenericDraft, mergeGenericDraftState } from '../dist/agent-runtime/draft/boundary.js';
import { createBuildModelTool } from '../dist/agent-langgraph/tools/build-model.js';
import { createLocalStructureProtocolClient } from '../dist/skill-shared/structure-protocol-execution.js';
import { genericFixtures } from './characterization/fixtures/generic-physics.mjs';

const field = 'engineeringDraft.topology.members["AD"].releases';
function stored(releases) {
  const engineeringDraft = structuredClone(genericFixtures[5].draft.engineeringDraft);
  engineeringDraft.topology.members.find(member => member.id === 'AD').releases = structuredClone(releases);
  return { inferredType: 'unknown', skillId: 'generic', updatedAt: 0, engineeringDraft,
    skillState: { engineeringDraft: structuredClone(engineeringDraft) } };
}
const axial = draft => draft.topology.members.find(member => member.id === 'AD');
const resultBody = result => JSON.parse(result.update.messages[0].content);

describe('member release draft boundary', () => {
  test('canonicalizes unambiguous moment/end aliases without mutating source or dropping false/translation flags', () => {
    const input = { releaseI: { mx: true, my: false, uy: true }, j: { mz: true }, reference_frame: 'element-local' };
    const before = structuredClone(input);
    expect(normalizeMemberReleases(input, field)).toEqual({ i: { uy: true, rx: true, ry: false }, j: { rz: true }, reference_frame: 'element-local' });
    expect(input).toEqual(before);
    expect(normalizeMemberReleases({ i: { mx: true, rx: true }, releaseI: { rx: true } }, field)).toEqual({ i: { rx: true } });
  });
  test.each([null, [], { i: [] }, { i: { ry: 'free' } }, { i: { ry: 1 } }, { unknown: {} },
    { i: { arbitraryMoment: true } }, { reference_frame: 'global' },
    { i: { mx: true, rx: false } }, { i: { ry: true }, releaseI: { my: false } },
  ])('rejects an invalid or conflicting definition rather than persisting it: %j', input => {
    expect(() => normalizeMemberReleases(input, field)).toThrow(MemberReleaseValidationError);
    expect(() => normalizeMemberReleases(input, field)).toThrow('MODEL_EDIT_FIELD_INVALID:');
  });
  test('normalizes a legacy record before merging a partial reply, without retaining stale aliases', () => {
    const before = stored({ releaseI: { mx: true, my: false }, j: { mz: true } }).engineeringDraft;
    const snapshot = structuredClone(before);
    const raw = { topology: { members: [{ id: 'AD', releases: { i: { rx: false } } }] } };
    const patch = normalizeEngineeringDraft(raw, before);
    const merged = mergeEngineeringDraft(before, patch);
    expect(axial(merged).releases).toEqual({ i: { rx: false, ry: false }, j: { rz: true } });
    expect(merged.topology.nodes).toEqual(before.topology.nodes);
    expect(merged.loadCases).toEqual(before.loadCases);
    expect(merged.materials).toEqual(before.materials);
    expect(merged.sectionRecords).toEqual(before.sectionRecords);
    expect(before).toEqual(snapshot);
  });
  test('rejects an invalid incoming patch atomically, preserving the accepted draft', () => {
    const before = stored({ i: { ry: true }, j: { rz: true } });
    const snapshot = structuredClone(before);
    expect(() => ingestGenericDraft({ engineeringDraft: { topology: { members: [{ id: 'AD', releases: { i: { bogus: true } } }] } } }, before))
      .toThrow('MODEL_EDIT_FIELD_INVALID');
    expect(before).toEqual(snapshot);
  });
  test('a poisoned legacy field gets a targeted repair path before any model call, then accepts a lossless correction', async () => {
    const draftState = stored({ i: { ry: true, bogus: false }, j: { rz: true } });
    const state = { draftState, model: { accepted: 'untouched' }, messages: [] };
    const before = structuredClone(state);
    const runtime = { buildModel: jest.fn(() => { throw new Error('Must not generate from poisoned metadata'); }) };
    const outcome = resultBody(await createBuildModelTool(runtime).invoke({}, {
      toolCall: { id: 'legacy-invalid' }, configurable: { agentState: state },
    }));
    expect(outcome).toMatchObject({ success: false, modelBuilt: false, errorCode: 'DRAFT_PROTOCOL_INVALID', field,
      nextAction: 'extract_draft_params', repair: { conflicting: false } });
    expect(outcome.repair.clearDraftFields).toEqual([field + '.i["bogus"]']);
    expect(runtime.buildModel).not.toHaveBeenCalled();
    expect(state).toEqual(before);
    const patch = ingestGenericDraft({ clearDraftFields: outcome.repair.clearDraftFields,
      engineeringDraft: { topology: { members: [{ id: 'AD', releases: { i: { ry: true } } }] } } }, draftState);
    const repaired = mergeGenericDraftState(draftState, patch);
    expect(axial(repaired.engineeringDraft).releases).toEqual({ i: { ry: true }, j: { rz: true } });
    for (const key of ['materials', 'sectionRecords', 'loadCases', 'analysisControl']) expect(repaired.engineeringDraft[key]).toEqual(draftState.engineeringDraft[key]);
    expect(repaired.engineeringDraft.topology.nodes).toEqual(draftState.engineeringDraft.topology.nodes);
    expect(state).toEqual(before);
  });
  test('conflicting legacy flags are not resolved by choosing or clearing one side', async () => {
    const draftState = stored({ i: { mx: true, rx: false } });
    const runtime = { buildModel: jest.fn() };
    const outcome = resultBody(await createBuildModelTool(runtime).invoke({}, {
      toolCall: { id: 'legacy-conflict' }, configurable: { agentState: { draftState } },
    }));
    expect(outcome.repair).toEqual({ conflicting: true, clearDraftFields: [] });
    expect(runtime.buildModel).not.toHaveBeenCalled();
    expect(axial(draftState.engineeringDraft).releases).toEqual({ i: { mx: true, rx: false } });
  });
  test('a successful build stores canonical legacy metadata and keeps its persisted mirror consistent', async () => {
    const draftState = stored({ releaseI: { my: true }, j: { mz: true } });
    const before = structuredClone(draftState);
    const controller = new AbortController();
    const runtime = { buildModel: jest.fn(async (draft, scope, context) => {
      expect(axial(draft.engineeringDraft).releases).toEqual({ i: { ry: true }, j: { rz: true } });
      expect(context.signal).toBe(controller.signal);
      return structuredClone(genericFixtures[5].model);
    }) };
    const result = await createBuildModelTool(runtime).invoke({}, { toolCall: { id: 'legacy-valid' }, signal: controller.signal,
      configurable: { structureProtocolClient: createLocalStructureProtocolClient(),
        agentState: { draftState, messages: [new HumanMessage(JSON.stringify(draftState.engineeringDraft))] } } });
    expect(resultBody(result).success).toBe(true);
    expect(axial(result.update.draftState.engineeringDraft).releases).toEqual({ i: { ry: true }, j: { rz: true } });
    expect(result.update.draftState.skillState.engineeringDraft).toEqual(result.update.draftState.engineeringDraft);
    expect(draftState).toEqual(before);
  }, 30_000);
});
