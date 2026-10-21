import { describe, test, expect } from '@jest/globals';
import { handler } from '../../../dist/agent-skills/structure-type/generic/handler.js';
import { computeDraftMissing } from '../../../dist/agent-runtime/draft-readiness.js';

describe('generic frame answer contract', () => {
  test.each(['fixed', '刚接', '嵌固', 'pinned'])('canonical support answer %s resolves the required base field', value => {
    const before = { inferredType: 'frame', skillId: 'generic', updatedAt: 0,
      engineeringDraft: { structureType: 'frame' },
      draftIssues: [{ field: 'boundary.frameBaseSupportType', kind: 'missing', severity: 'missing', reason: 'base required' }],
      skillState: { invalidDraftFields: ['boundary.frameBaseSupportType'] } };
    const patch = handler.extractDraft({ currentState: before, message: value, locale: 'zh',
      llmDraftPatch: { engineeringDraft: { boundary: { supportType: value } } } });
    const after = handler.mergeState(before, patch);
    expect(after.engineeringDraft.boundary.frameBaseSupportType).toBe(value === 'pinned' ? 'pinned' : 'fixed');
    expect(computeDraftMissing({ id: 'generic', handler }, after, 'execution').critical).not.toContain('boundary.frameBaseSupportType');
  });
});
