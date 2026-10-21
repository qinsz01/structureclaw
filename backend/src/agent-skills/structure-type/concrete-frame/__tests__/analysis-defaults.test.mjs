import { expect, test } from '@jest/globals';
import { buildAnalysisControlRecord } from '../../../../../dist/agent-skills/structure-type/concrete-frame/model/records.js';

test('rigid floors require an explicit request', () => {
  expect(buildAnalysisControlRecord(undefined)).toMatchObject({ rigid_floor: false, p_delta: false });
  expect(buildAnalysisControlRecord({ rigidFloor: true })).toMatchObject({ rigid_floor: true });
  expect(buildAnalysisControlRecord(undefined, false)).toBeUndefined();
});
