import { describe, expect, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';
import { handler } from '../../../../dist/agent-skills/structure-type/concrete-frame/handler.js';
import { buildCodeCheckInput } from '../../../../dist/agent-skills/code-check/entry.js';
import { PythonWorkerRunner } from '../../../../dist/utils/python-worker-runner.js';

const declaredRebar = {
  As: 1256, Asv: 100.5, stirrup_dia: 8, stirrup_spacing: 150,
  main_dia: 20, bar_count: 4, sn: 54.7, cover: 20, crack_cover: 30,
};
const makeModel = () => handler.buildModel({
  inferredType: 'frame', structuralTypeKey: 'concrete-frame', frameDimension: '2d',
  storyCount: 1, storyHeightsM: [3.6], bayCount: 1, bayWidthsM: [6],
  floorLoads: [{ story: 1, verticalKN: 10 }], frameConcreteGrade: 'C30',
  frameRebarGrade: 'HRB400', frameColumnSection: '500X500', frameBeamSection: '300X600',
  frameBaseSupportType: 'fixed', updatedAt: 0,
});
function inputFor(model) {
  const beam = model.elements.find(e => e.type === 'beam');
  return buildCodeCheckInput({
    traceId: 'reinforcement-provenance', designCode: 'GB50010', model, analysisParameters: {},
    codeCheckElements: [beam.id],
    analysis: {
      meta: { units: { force: 'N', moment: 'N.mm' } },
      data: { forces: { [beam.id]: { n1: { N: 0, V: 1000, M: 1000000 } } } },
    },
  });
}
const worker = new PythonWorkerRunner(fileURLToPath(new URL('../worker.py', import.meta.url)));
const check = input => worker.invoke({ action: 'code_check', input: { ...input, model_id: input.modelId } });
const allItems = result => result.details.flatMap(detail => detail.checks.flatMap(group => group.items));

describe('confirmed reinforcement through the production bridge and Python checker', () => {
  test.each(['current', 'historical'])('%s automatic concrete template cannot pass without actual reinforcement', async (version) => {
    const model = makeModel();
    if (version === 'historical') {
      // This is exactly the old template storage shape, not a user confirmation.
      for (const element of model.elements) element.metadata = { ...declaredRebar };
    }
    const before = JSON.stringify(model);
    const input = inputFor(model);
    const beam = input.context.elementData[input.elements[0]];
    expect(beam.As).toBeUndefined();
    expect(beam.Asv).toBeUndefined();
    expect(JSON.stringify(model)).toBe(before);
    const result = await check(input);
    expect(result.complianceStatus).toBe('incomplete');
    expect(result.summary.passed).toBe(0);
    expect(result.summary.maxUtilization).toBeNull();
    expect(allItems(result).find(item => item.item === '正截面受弯').status).toBe('input_required');
  });

  test.each(['element', 'metadata', 'section'])('confirmed %s reinforcement remains usable with actual force data', async (location) => {
    const model = makeModel();
    const beam = model.elements.find(e => e.type === 'beam');
    const reinforcement = { confirmed: true, ...declaredRebar };
    if (location === 'section') model.sections.find(s => s.id === beam.section).reinforcement = reinforcement;
    else if (location === 'metadata') beam.metadata = { reinforcement };
    else beam.reinforcement = reinforcement;
    const input = inputFor(model);
    expect(input.context.elementData[beam.id].As).toBe(1256);
    const result = await check(input);
    const bending = allItems(result).find(item => item.item === '正截面受弯');
    expect(bending.status).toBe('pass');
    // Independently evaluated singly reinforced rectangular-section formula, N / mm units.
    const h0 = 600 - 20 - 8 - 20 / 2;
    const x = 360 * 1256 / (14.3 * 300);
    expect(bending.utilization).toBeCloseTo(1000000 / (14.3 * 300 * x * (h0 - x / 2)), 4);
    expect(allItems(result).find(item => item.item === '斜截面受剪').status).toBe('pass');
    expect(result.complianceStatus).toBe('incomplete'); // service-state data were not provided
  });

  test('an unconfirmed proposal cannot bypass the gate through raw context, metadata, or flat fallback', () => {
    const model = makeModel();
    model.metadata.source = 'explicit-user-model';
    const beam = model.elements.find(e => e.type === 'beam');
    beam.metadata = { ...declaredRebar, reinforcement: { confirmed: false, ...declaredRebar } };
    const input = inputFor(model);
    expect(input.context.elementData[beam.id].As).toBeUndefined();
    expect(input.context.elementData[beam.id].reinforcement).toBeUndefined();
    expect(input.context.elementContextById[beam.id].reinforcement.As).toBeUndefined();
    expect(input.context.elementContextById[beam.id].metadata.As).toBeUndefined();
  });

  test('legacy explicit user reinforcement is preserved outside automatic template models', () => {
    const model = makeModel();
    model.metadata.source = 'explicit-user-model';
    const beam = model.elements.find(e => e.type === 'beam');
    beam.metadata = { ...declaredRebar };
    expect(inputFor(model).context.elementData[beam.id].As).toBe(1256);
  });
});
