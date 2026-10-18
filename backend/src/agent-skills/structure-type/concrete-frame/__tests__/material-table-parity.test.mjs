import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCRETE_GRADES, REBAR_GRADES } from '../../../../../dist/agent-skills/structure-type/concrete-frame/model/materials.js';
import { resolvePythonCommand } from '../../../../../tests/fixtures/python-command.mjs';

// The Python GB 50010 tables are the source of truth; the concrete-frame TS copy must match them.
const pythonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../skill-shared/python');
const pythonCommand = resolvePythonCommand();

describe('concrete-frame material tables match design_code_tables.py', () => {
  if (!pythonCommand) {
    test.skip('no usable Python', () => {});
    return;
  }
  const dump = spawnSync(pythonCommand.executable, [...pythonCommand.args, '-c',
    'import json; from structure_protocol.design_code_tables import CONCRETE_GRADES, REBAR_GRADES; '
    + 'print(json.dumps({"concrete": CONCRETE_GRADES, "rebar": REBAR_GRADES}))'],
  { cwd: pythonDir, encoding: 'utf8', windowsHide: true });
  const python = JSON.parse(dump.stdout);

  test.each([['concrete', CONCRETE_GRADES], ['rebar', REBAR_GRADES]])('%s grades and values', (kind, table) => {
    for (const [grade, row] of Object.entries(table)) {
      const { grade: label, ...values } = row;
      expect(label).toBe(grade);
      expect(values).toEqual(python[kind][grade]);
    }
  });
});
