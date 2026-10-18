// edit_model on a force-only placeholder model: real material and section for every member lift the
// placeholder; anything less keeps it (and its displacement/check/report blocking).
import { beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.SCLAW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sclaw-placeholder-edit-'));

let edit, protocol, initial, stiffnessPlaceholderOf;
const FORCES = { responses: ['forces', 'reactions'], design: false, outputs: [] };
const beamDraft = { inferredType: 'beam', lengthM: 10, loadKN: 1, loadType: 'point', loadPosition: 'midspan', supportType: 'simply-supported',
  requestScope: FORCES, engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
    loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }] } };

beforeAll(async () => {
  const { createEditModelTool } = await import('../dist/agent-langgraph/model-tools.js');
  const { createLocalStructureProtocolClient } = await import('../dist/services/structure-protocol-execution.js');
  const { normalizeEngineeringModel } = await import('../dist/engineering/model-boundary.js');
  const { commitModel } = await import('../dist/engineering/model-state.js');
  const { buildModel } = await import('../dist/agent-runtime/model-builder.js');
  ({ stiffnessPlaceholderOf } = await import('../dist/engineering/stiffness-placeholder.js'));
  protocol = createLocalStructureProtocolClient(); edit = createEditModelTool();
  initial = commitModel({}, await normalizeEngineeringModel(buildModel(beamDraft), protocol), 'initial');
});
const invoke = edits => edit.invoke({ baseRevision: initial.modelRevision, edits },
  { toolCall: { id: 'placeholder-edit' }, configurable: { agentState: initial, structureProtocolClient: protocol } });
const realMaterial = { name: 'Q355', grade: 'Q355', category: 'steel', E: 206000, nu: 0.3, rho: 7850 };
const realSection = { name: 'H300x150x6.5x9', type: 'custom', properties: { A: 0.004678, Iy: 7.21e-5, Iz: 5.08e-6, J: 1.1e-7 } };

describe('edit_model and placeholder stiffness', () => {
  test('the starting model is a placeholder model', () => {
    expect(stiffnessPlaceholderOf(initial.model)).toMatchObject({ material: true, section: true });
  });

  test('real material and section for every member clear the placeholder metadata and records', async () => {
    const { update } = await invoke([
      { operation: 'update', collection: 'materials', id: '1', values: realMaterial },
      { operation: 'update', collection: 'sections', id: '1', values: realSection },
    ]);
    expect(stiffnessPlaceholderOf(update.model)).toBeUndefined();
    expect(JSON.stringify([update.model.materials, update.model.sections])).not.toContain('stiffnessPlaceholder');
    expect(update.model.materials[0]).toMatchObject({ id: '1', name: 'Q355', E: 206000 });
  });

  test('new real records assigned to every member remove the unused placeholder records', async () => {
    const elementIds = initial.model.elements.map(element => element.id);
    const { update } = await invoke([
      { operation: 'add', collection: 'materials', id: 'M-Q355', values: realMaterial },
      { operation: 'add', collection: 'sections', id: 'S-H300', values: realSection },
      ...elementIds.map(id => ({ operation: 'update', collection: 'elements', id, values: { material: 'M-Q355', section: 'S-H300' } })),
    ]);
    expect(stiffnessPlaceholderOf(update.model)).toBeUndefined();
    expect(update.model.materials.map(row => row.id)).toEqual(['M-Q355']);
    expect(update.model.sections.map(row => row.id)).toEqual(['S-H300']);
  });

  test('only the material keeps the placeholder and its blocking', async () => {
    const { update } = await invoke([{ operation: 'update', collection: 'materials', id: '1', values: realMaterial }]);
    expect(stiffnessPlaceholderOf(update.model)).toMatchObject({ material: true, section: true });
    expect(update.model.sections[0].extra).toEqual({ stiffnessPlaceholder: true });
    expect(update.model.materials[0].extra).toBeUndefined();
  });
});
