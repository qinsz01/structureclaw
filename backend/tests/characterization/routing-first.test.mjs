import { expect, test } from '@jest/globals';
import { toolCall } from './helpers/llm-fixture.mjs';
import { describeWithOpenSees, internalResponder, routerDecision, runTurn, setupHarness, TURN_TIMEOUT_MS } from './helpers/harness.mjs';

describeWithOpenSees('characterization: LLM-required routing', () => {
  const ctx = setupHarness();
  test('routes new structures, reuses their detection, and extracts generic drafts through the LLM', async () => {
    let routes = 0, extracts = 0;
    ctx.llm.setInternal(internalResponder({
      'structural-router': () => { routes++; return routes === 1 ? routerDecision('beam') : {
        action: 'generic', skillId: 'generic', structuralTypeKey: 'unknown', mappedType: 'unknown',
        supportLevel: 'supported', confidence: .99,
      }; },
      'param-extractor': () => { extracts++; return {
        requestScope: { responses: ['forces'], design: false, report: false, outputs: [] },
        engineeringDraft: { structureType: extracts === 1 ? 'beam' : 'unknown', geometry: { lengthM: extracts === 1 ? 6 : 9 } },
      }; },
    }));
    const first = await runTurn(ctx, { message: 'Record a 6m beam draft only.', context: { locale: 'en' } }, [
      toolCall('detect_structure_type', {}, 'detect'), toolCall('extract_draft_params', {}, 'extract'), 'DRAFT_RECORDED',
    ]);
    expect([routes, extracts]).toEqual([1, 1]);
    const second = await runTurn(ctx, { conversationId: first.conversationId, message: 'Start a new custom structure draft, 9m long.', context: { locale: 'en' } }, [
      toolCall('detect_structure_type', {}, 'detect-new'), toolCall('extract_draft_params', {}, 'extract-new'), 'DRAFT_RECORDED',
    ]);
    expect([routes, extracts]).toEqual([2, 2]);
    expect(second.requests.some(request => request.kind === 'param-extractor')).toBe(true);
    const third = await runTurn(ctx, { conversationId: first.conversationId, message: 'Keep this custom draft and record its length as 9m.', context: { locale: 'en' } }, [
      toolCall('extract_draft_params', {}, 'extract-generic'), 'DRAFT_RECORDED',
    ]);
    // Accepted generic state is supported and reusable; extraction still calls the LLM.
    expect([routes, extracts]).toEqual([2, 3]);
    const routingEvents = ctx.backend.runRecords().flatMap(item => item.record.usage.events).filter(event => event.kind === 'structural_routing');
    expect(routingEvents.filter(event => event.path === 'llm')).toHaveLength(2);
    expect(routingEvents.filter(event => event.path === 'reused')).toEqual([
      expect.objectContaining({ skillId: 'generic', source: 'llm-suggested' }),
    ]);
    expect(third.requests.some(request => request.kind === 'param-extractor')).toBe(true);
  }, TURN_TIMEOUT_MS);
});
