import { expect, test } from '@jest/globals';
import { mergeDraftState } from '../../../dist/agent-runtime/draft/boundary.js';
import { mergeEngineeringDraft } from '../../../dist/agent-runtime/engineering-draft.js';
const first = { structureType: 'beam', geometry: { lengthM: 10 }, loads: [{ kind: 'point', magnitude: 1, unit: 'kN', target: 'beam', location: { xM: 5, spanIndex: 1 } }] };
test('clarification refines load direction without doubling the force', () => {
  const next = mergeEngineeringDraft(first, { loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'midspan', location: { xM: 5 } }] });
  expect(next.loads).toHaveLength(1);
  expect(next.loads[0]).toMatchObject({ magnitude: 1, direction: 'gravity', location: { xM: 5 } });
  expect(first.loads[0].direction).toBeUndefined();
  expect(mergeEngineeringDraft(next, first).loads).toHaveLength(1);
  expect(mergeEngineeringDraft(next, first).loads[0].direction).toBe('gravity');
});
test.each([
  [{ direction: 'gravity' }, { direction: 'globalX' }],
  [{ caseId: 'D' }, { caseId: 'L' }],
  [{ id: 'one' }, { id: 'two' }],
  [{ location: { xM: 2 } }, { location: { xM: 5 } }],
])('preserves explicitly distinct loads %j versus %j', (before, after) => {
  const load = { kind: 'point', magnitude: 1, unit: 'kN', location: { xM: 5 } };
  const next = mergeEngineeringDraft({ structureType: 'beam', geometry: { lengthM: 10 }, loads: [{ ...load, ...before }] }, { loads: [{ ...load, ...after }] });
  expect(next.loads).toHaveLength(2);
});


test('a classified load clears only its own stale case-type diagnostic', () => {
  const load={...first.loads[0],id:'P',caseId:'LC1'};
  const fields=['loads[0].caseType','engineeringDraft.loads[0].caseType','loads[0].direction','loads[1].caseType','designCheck.stabilityCoefficient'];
  const state={inferredType:'beam',updatedAt:0,engineeringDraft:{...first,loads:[load,{...load,id:'Q',caseId:'LC2'}]},
    draftIssues:fields.map(field=>({field,severity:'ambiguous',reason:'Needs confirmation'})),
    skillState:{invalidDraftFields:fields}};
  const patch={engineeringDraft:{loads:[{...load,caseType:'other'}]}};
  const next=mergeDraftState(state,patch);
  expect(next.engineeringDraft.loads).toHaveLength(2);
  expect(next.engineeringDraft.loads[0].caseType).toBe('other');
  expect(next.draftIssues.map(issue=>issue.field)).toEqual(fields.slice(2));
  expect(next.skillState.invalidDraftFields).toEqual(fields.slice(2));
  expect(state.draftIssues).toHaveLength(5);
  // A fresh conflict always wins over a resolved old diagnostic.
  const conflict={field:'loads[0].caseType',severity:'conflict',reason:'Contradictory category supplied'};
  expect(mergeDraftState(state,{...patch,draftIssues:[conflict],skillState:{invalidDraftFields:[conflict.field]}}).draftIssues).toContainEqual(conflict);
  expect(mergeDraftState(state,{engineeringDraft:{loads:[load]}}).draftIssues).toEqual(state.draftIssues);
});


test('the original three-turn beam clarification assigns LC1 once without inventing a combination', () => {
  const supported={...first,loads:[{...first.loads[0],direction:'gravity'}]};
  const fields=['loads[0].caseType','designCheck.stabilityCoefficient'];
  const state={inferredType:'beam',updatedAt:0,engineeringDraft:supported,
    draftIssues:fields.map(field=>({field,severity:'ambiguous',reason:'Needs confirmation'})),
    skillState:{invalidDraftFields:fields}};
  const patch={engineeringDraft:{loads:[{kind:'point',magnitude:1,unit:'kN',direction:'gravity',target:'midspan',location:{xM:5},caseId:'LC1',caseType:'other'}]}};
  const next=mergeDraftState(state,patch);
  expect(next.engineeringDraft.loads).toHaveLength(1);
  expect(next.engineeringDraft.loads[0]).toMatchObject({magnitude:1,direction:'gravity',caseId:'LC1',caseType:'other',location:{xM:5}});
  expect(next.engineeringDraft.analysis?.loadCombinations).toBeUndefined();
  expect(next.draftIssues.map(issue=>issue.field)).toEqual(['designCheck.stabilityCoefficient']);
  expect(next.skillState.invalidDraftFields).toEqual(['designCheck.stabilityCoefficient']);
  expect(supported.loads[0].caseId).toBeUndefined();
});

test.each([
  [{caseId:'D'},{caseId:'L'}],
  [{caseType:'dead'},{caseType:'live'}],
  [{location:{xM:2}},{location:{xM:5},caseId:'LC1'}],
  [{magnitude:1},{magnitude:2,caseId:'LC1'}],
  [{direction:'globalX'},{direction:'gravity',caseId:'LC1'}],
  [{id:'P'},{caseId:'LC1'}],
])('case clarification preserves distinct physical loads %j versus %j', (before,after) => {
  const load={kind:'point',magnitude:1,unit:'kN',location:{xM:5}};
  const next=mergeEngineeringDraft({...first,loads:[{...load,...before}]},{loads:[{...load,...after}]});
  expect(next.loads).toHaveLength(2);
});

test('case assignment does not guess between multiple compatible anonymous forces', () => {
  const load={kind:'point',magnitude:1,unit:'kN',location:{xM:5}};
  const next=mergeEngineeringDraft({...first,loads:[load,{...load,direction:'gravity'}]},
    {loads:[{...load,caseId:'LC1',direction:'gravity'}]});
  expect(next.loads).toHaveLength(3);
  expect(next.loads.filter(item=>item.caseId===undefined)).toHaveLength(2);
});


test('classifying a distinct-direction force does not clear the original force diagnostic', () => {
  const load={kind:'point',magnitude:1,unit:'kN',location:{xM:5},caseId:'LC1',direction:'gravity'};
  const issue={field:'loads[0].caseType',severity:'ambiguous',reason:'The original force still needs a category'};
  const next=mergeDraftState({inferredType:'beam',updatedAt:0,engineeringDraft:{...first,loads:[load]},
    draftIssues:[issue],skillState:{invalidDraftFields:[issue.field]}},
    {engineeringDraft:{loads:[{...load,direction:'globalX',caseType:'other'}]}});
  expect(next.engineeringDraft.loads).toHaveLength(2);
  expect(next.draftIssues).toEqual([issue]);
  expect(next.skillState.invalidDraftFields).toEqual([issue.field]);
});
