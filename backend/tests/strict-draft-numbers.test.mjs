import { describe, expect, test } from '@jest/globals';
import { normalizeNumber } from '../dist/agent-runtime/draft/normalize.js';
import { ingestDraft } from '../dist/agent-runtime/draft/boundary.js';

describe('draft numbers require structured numeric input', () => {
  test.each(['不是三层', '三层', '六', '10不是12', '12m', '10 or 12', 'about 12'])('never infers a number from %s', value => {
    expect(normalizeNumber(value)).toBeUndefined();
    const patch = ingestDraft({ lengthM: value });
    expect(patch.lengthM).toBeUndefined();
    expect(patch.skillState.invalidDraftFields).toContain('lengthM');
  });

  test.each([12, '12', ' -2.5 ', '1e3'])('retains complete numeric input %s', value => {
    expect(normalizeNumber(value)).toBe(Number(value));
  });

  test('a rejected dimension in an array remains an unresolved input', () => {
    const patch = ingestDraft({ bayWidthsM: [5, '不是三跨'] });
    expect(patch.skillState.invalidDraftFields).toContain('bayWidthsM');
  });
});
