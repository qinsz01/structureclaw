import { expect, test } from '@jest/globals';
import { normalizeMemberReleases } from '../../../dist/engineering/member-releases.js';
import { tryBuildGenericModelWithLlm } from '../../../dist/agent-skills/structure-type/generic/llm-model-builder.js';
import { genericFixtures } from '../../../tests/characterization/fixtures/generic-physics.mjs';

test('explicit release patches retain strict validation', () => {
  expect(normalizeMemberReleases({ i: { ry: true } }, 'member.releases')).toEqual({ i: { ry: true } });
  for (const value of [null, false, [], { i: null }, { i: { ry: 'true' } }, { i: { ry: true }, releaseI: { ry: false } }]) {
    expect(() => normalizeMemberReleases(value, 'member.releases')).toThrow('MODEL_EDIT_FIELD_INVALID');
  }
});

test('full V2 model candidates accept optional null release/design fields without erasing explicit definitions', async () => {
  const model=structuredClone(genericFixtures[2].model);
  model.elements.forEach(member=>{member.releases=null;});
  model.materials[0].design=null;
  const original=structuredClone(model);
  const result=await tryBuildGenericModelWithLlm({invoke:async()=>({content:JSON.stringify(model)})},'Build these confirmed inputs.',
    {inferredType:'unknown',updatedAt:0,engineeringDraft:{materials:model.materials,sectionRecords:model.sections,loadCases:model.load_cases}},'en');
  expect(result.nodes).toEqual(model.nodes);
  expect(result.elements.every(member=>member.releases===null)).toBe(true);
  expect(result.materials[0].design).toBeNull();
  expect(result.metadata.physicsCheck.valid).toBe(true);
  expect(model).toEqual(original);
});
