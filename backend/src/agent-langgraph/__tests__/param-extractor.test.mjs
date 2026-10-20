import { describe, expect, test } from "@jest/globals";

// Tests that call createLocalStructureProtocolClient() spawn a cold Python structure-protocol worker
// per schema/validate call (about 1 s each when idle, several times that on a loaded machine), so
// the 5 s Jest default leaves no headroom for the 1-3 spawns they make.
const PYTHON_WORKER_TEST_TIMEOUT_MS = 30_000;

const beamPlugin = {
  id: "beam",
  name: { zh: "梁", en: "Beam" },
  description: { zh: "单跨梁参数提取", en: "Beam parameter extraction" },
  stages: ["draft"],
  structureType: "beam",
  markdownByStage: {
    draft: [
      "- 必填参数：`lengthM`, `supportType`, `loadKN`",
      "- \"跨度6m\" -> `lengthM: 6`",
      "- \"均布荷载20kN/m\" -> `loadKN: 20`, `loadType: distributed`",
    ].join("\n"),
  },
};

describe("param extractor", () => {
  test.each(['length', 'empty', 'unparsable'])('retries an unusable patch once with a short contract (%s)', async kind => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const prompts = [];
    const expected = { engineeringDraft: { material: { grade: 'Q235' } } };
    const actual = await invokeParamExtractor({ message: '材料Q235钢，截面工字钢I20a', locale: 'zh', plugin: beamPlugin,
      existingState: { inferredType: 'beam', engineeringDraft: { geometry: { lengthM: 10 } } },
      llm: { invoke: async prompt => {
        prompts.push(prompt);
        return prompts.length === 1
          ? { content: kind === 'unparsable' ? 'invalid JSON' : kind === 'length' ? JSON.stringify(expected) : '',
            response_metadata: { finish_reason: kind === 'length' ? 'length' : 'stop' } }
          : { content: JSON.stringify(expected) };
      } } });
    expect(actual).toEqual(expected);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('RETRY CONTRACT');
    expect(prompts.every(prompt => prompt.includes('PATCH ONLY'))).toBe(true);
  });

  test('two unusable patches fall back to full extraction, never rule-only success', async () => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const prompts = [];
    const input = { message: 'Q235', locale: 'en', plugin: beamPlugin,
      existingState: { inferredType: 'beam', engineeringDraft: {} } };
    await expect(invokeParamExtractor({ ...input, llm: { invoke: async prompt => {
      prompts.push(prompt);
      return { content: prompts.length < 3 ? '' : '{"engineeringDraft":{"material":{"grade":"Q235"}}}' };
    } } })).resolves.toMatchObject({ engineeringDraft: { material: { grade: 'Q235' } } });
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('Request goal');
    expect(prompts[2]).not.toContain('PATCH ONLY');
    await expect(invokeParamExtractor({ ...input, llm: { invoke: async () => ({ content: '' }) } }))
      .rejects.toThrow('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT');
  });
  test.each(['zh', 'en'])('passes the authoritative design field definitions to the extraction model (%s)', async locale => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const { createLocalStructureProtocolClient } = await import('../../../dist/services/structure-protocol-execution.js');
    const { engineeringModelSchema, draftDesignSchema, draftSectionShapeSchema } = await import('../../../dist/engineering/model-edit-contract.js');
    const contract = await engineeringModelSchema(createLocalStructureProtocolClient());
    const designSchema = draftDesignSchema(contract), sectionShapeSchema = draftSectionShapeSchema(contract);
    for (const focusFields of [[], ['materials.M.rho']]) {
      let sent;
      await invokeParamExtractor({ message: 'Use supplied design conditions', locale, plugin: beamPlugin, designSchema, sectionShapeSchema,
        focusFields, llm: { invoke: async prompt => { sent = prompt; return { content: '{"engineeringDraft":{"geometry":{"lengthM":10}}}' }; } } });
      expect(sent).toContain(JSON.stringify(designSchema));
      expect(sent).toContain(JSON.stringify(sectionShapeSchema));
      expect(sectionShapeSchema.properties.kind.enum).toContain('H');
      expect(sectionShapeSchema.properties.kind.enum).not.toContain('h');
      expect(sent).toContain('design.basis is a map of nonempty strings');
      expect(sent).toContain('metadata.unmappedDesignParameters');
      expect(designSchema.$defs.MemberDesign.properties.stressCheckType).toBeUndefined();
    }
  }, PYTHON_WORKER_TEST_TIMEOUT_MS);
  test('a load-direction answer clears its old diagnostic without erasing unrelated issues', async () => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const initial = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: {
      engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
        loads: [{ id: 'P', kind: 'point', magnitude: 1, unit: 'kN', target: 'beam', location: { xM: 5 } }] },
      draftIssues: [{ field: 'loads[0].direction', severity: 'ambiguous', reason: 'Direction not supplied' },
        { field: 'material.grade', severity: 'ambiguous', reason: 'Grade not supplied' }],
      skillState: { invalidDraftFields: ['loads[0].direction', 'material.grade'] },
    } }));
    const patch = load => handler.extractDraft({ locale: 'zh', llmDraftPatch: { engineeringDraft: { loads: [load] }, draftIssues: [] } });
    const load = { id: 'P', kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', target: 'beam', location: { xM: 5 } };
    const updated = handler.mergeState(initial, patch(load));
    expect(updated.draftIssues.map(issue => issue.field)).toEqual(['material.grade']);
    expect(updated.skillState.invalidDraftFields).toEqual(['material.grade']);
    expect(updated.engineeringDraft.loads).toHaveLength(1);
    expect(updated.engineeringDraft.loads[0].direction).toBe('gravity');
    expect(handler.mergeState(initial, patch({ ...load, id: 'OTHER' })).draftIssues).toEqual(initial.draftIssues);
    const twoLoads = structuredClone(initial);
    twoLoads.engineeringDraft.loads.push({ ...twoLoads.engineeringDraft.loads[0], id: 'Q', location: { xM: 7 } });
    twoLoads.draftIssues.push({ field: 'loads[1].direction', severity: 'ambiguous', reason: 'Second direction not supplied' });
    twoLoads.skillState.invalidDraftFields.push('loads[1].direction');
    const secondOnly = handler.mergeState(twoLoads, patch({ ...load, id: 'Q', location: { xM: 7 } }));
    expect(secondOnly.draftIssues.map(issue => issue.field)).toEqual(['loads[0].direction', 'material.grade']);
    expect(secondOnly.skillState.invalidDraftFields).toEqual(['loads[0].direction', 'material.grade']);
    const withoutId = structuredClone(initial);
    delete withoutId.engineeringDraft.loads[0].id;
    delete load.id;
    expect(handler.mergeState(withoutId, patch(load)).draftIssues.map(issue => issue.field)).toEqual(['material.grade']);
    expect(initial.engineeringDraft.loads[0].direction).toBeUndefined();
  });

  test.each([
    content => [{ type: 'text', text: content }],
    content => [{ type: 'reasoning', reasoning: 'private reasoning' }, { type: 'text', text: content.slice(0, 20) }, { type: 'text', text: content.slice(20) }],
  ])('reads JSON from provider text blocks without losing the engineering draft', async wrap => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const patch = { engineeringDraft: { geometry: { lengthM: 10 } }, requestScope: { responses: [] } };
    const result = await invokeParamExtractor({ message: '10m beam', locale: 'en', plugin: beamPlugin,
      requireLlmResult: true, llm: { invoke: async () => ({ content: wrap(JSON.stringify(patch)) }) } });
    expect(result).toEqual(patch);
  });

  test.each([undefined, null, [], [{ type: 'reasoning', reasoning: '{"geometry":{"lengthM":999}}' }]])('empty/non-text provider output has a controlled diagnostic (%j)', async content => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    await expect(invokeParamExtractor({ message: '10m beam', locale: 'en', plugin: beamPlugin,
      requireLlmResult: true, llm: { invoke: async () => ({ content }) } })).rejects.toThrow('LLM_PARAM_EXTRACTOR_INVALID_OUTPUT');
  });

  test('a density clarification preserves accepted elastic constants and reaches formal model validation', async () => {
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { computeDraftMissing } = await import('../../../dist/agent-runtime/draft-readiness.js');
    const { normalizeEngineeringModel } = await import('../../../dist/engineering/model-boundary.js');
    const { createLocalStructureProtocolClient } = await import('../../../dist/services/structure-protocol-execution.js');
    const initial = handler.mergeState(undefined, handler.extractDraft({ locale: 'zh', llmDraftPatch: {
      engineeringDraft: { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
        loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }],
        materials: [{ id: 'M', name: 'Elastic material', E: 206000, nu: 0.3 }], sections: { beam: '100X200' } },
    } }));
    expect(computeDraftMissing({ id: 'beam', handler }, initial, 'execution').critical).toEqual(['materials.M.rho']);
    const next = handler.mergeState(initial, handler.extractDraft({ locale: 'zh', llmDraftPatch: {
      engineeringDraft: { materials: [{ id: 'M', rho: 7850 }] },
    } }));
    expect(computeDraftMissing({ id: 'beam', handler }, next, 'execution').critical).toEqual([]);
    const normalized = await normalizeEngineeringModel(handler.buildModel(next), createLocalStructureProtocolClient());
    expect(normalized.materials[0]).toMatchObject({ id: 'M', name: 'Elastic material', E: 206000, nu: 0.3, rho: 7850 });
    expect(initial.engineeringDraft.materials[0].rho).toBeUndefined();
  }, PYTHON_WORKER_TEST_TIMEOUT_MS);

  test.each(['zh', 'en'])('documents numerical materials and preserves them through beam template construction (%s)', async (locale) => {
    const { buildParamExtractorPrompt, parseDraftPatchFromContent } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const { computeDraftMissing } = await import('../../../dist/agent-runtime/draft-readiness.js');
    const { normalizeEngineeringModel } = await import('../../../dist/engineering/model-boundary.js');
    const { createLocalStructureProtocolClient } = await import('../../../dist/services/structure-protocol-execution.js');
    const prompt = buildParamExtractorPrompt(locale, undefined, beamPlugin, '10 m simply supported beam; 1 kN midspan; E=206000 MPa; nu=0.3; rho=7850 kg/m3; rectangular 100x200 mm.');
    for (const key of ['"materials"', '"E"', '"rho"', '"sectionRecords"', '"templateAssignments"']) expect(prompt).toContain(key);
    const draft = { structureType: 'beam', geometry: { lengthM: 10 }, boundary: { supportType: 'simply-supported' },
      loads: [{ kind: 'point', magnitude: 1, unit: 'kN', direction: 'gravity', location: { xM: 5 } }],
      materials: [{ id: 'elastic', name: 'Elastic material', E: 206000, nu: 0.3, rho: 7850 }], sections: { beam: '100X200' } };
    const patch = handler.extractDraft({ locale, llmDraftPatch: parseDraftPatchFromContent(JSON.stringify({ engineeringDraft: draft })) });
    const state = handler.mergeState(undefined, patch);
    expect(computeDraftMissing({ id: 'beam', handler }, state, 'execution').critical).toEqual([]);
    const model = handler.buildModel(state);
    expect(model.materials).toEqual(draft.materials);
    expect(model.sections[0].properties.A).toBeCloseTo(0.02, 12);
    expect(model.sections[0].properties.Iy).toBeCloseTo(0.1 * 0.2 ** 3 / 12, 12);
    expect(model.nodes.some(node => node.x === 5)).toBe(true);
    const normalized = await normalizeEngineeringModel(model, createLocalStructureProtocolClient());
    expect(normalized.materials[0]).toMatchObject(draft.materials[0]);
    const explicit = structuredClone(draft);
    explicit.sectionRecords = [{ id: 'S', name: 'Reviewed section', type: 'custom', properties: { A: 0.02, Iy: 0.0000666666666667, Iz: 0.0000166666666667, J: 0.000045776 } }];
    explicit.sections.beam = 'S';
    const explicitState = handler.mergeState(undefined, handler.extractDraft({ locale, llmDraftPatch: { engineeringDraft: explicit } }));
    const explicitNormalized = await normalizeEngineeringModel(handler.buildModel(explicitState), createLocalStructureProtocolClient());
    expect(explicitNormalized.sections[0]).toMatchObject(explicit.sectionRecords[0]);
  }, PYTHON_WORKER_TEST_TIMEOUT_MS);

  test.each([
    ['zh', []], ['en', []], ['zh', ['materials.M.rho']], ['en', ['materials.M.rho']],
  ])('the actual extractor request preserves section sources in normal and focused prompts (%s, %j)', async (locale, focusFields) => {
    const { invokeParamExtractor } = await import('../../../dist/agent-langgraph/param-extractor.js');
    const { handler } = await import('../../../dist/agent-skills/structure-type/beam/handler.js');
    const section = { id: 'source-section', name: 'User dimensions and measured inertia', type: 'rectangular',
      shape: { kind: 'rectangular', B: 100, H: 200 }, properties: { Iy: 0.0001 },
      extra: { source: 'explicit-user-table' } };
    const state = handler.mergeState(undefined, handler.extractDraft({ locale, llmDraftPatch: {
      engineeringDraft: { materials: [{ id: 'M', E: 206000, nu: 0.3 }], sectionRecords: [section] },
    } }));
    const before = structuredClone(state);
    let sentPrompt;
    const patch = await invokeParamExtractor({ message: 'rho=7850 kg/m3', existingState: state, locale, plugin: beamPlugin,
      focusFields, requireLlmResult: true, llm: { invoke: async prompt => {
        sentPrompt = prompt;
        return { content: JSON.stringify({ engineeringDraft: { materials: [{ id: 'M', rho: 7850 }] } }) };
      } } });
    expect(sentPrompt.length).toBeLessThan(10000);
    expect(sentPrompt).toContain('PATCH ONLY');
    expect(sentPrompt).toContain('Explicit USER properties win');
    expect(sentPrompt).toContain('Preserve exact existing IDs');
    expect(sentPrompt).toContain('"H":200');
    expect(sentPrompt).toContain('"Iy":0.0001');
    expect(sentPrompt).toContain('explicit-user-table');
    const next = handler.mergeState(state, handler.extractDraft({ locale, currentState: state, llmDraftPatch: patch }));
    expect(next.engineeringDraft.sectionRecords).toEqual([section]);
    expect(next.engineeringDraft.materials[0]).toMatchObject({ id: 'M', E: 206000, nu: 0.3, rho: 7850 });
    expect(state).toEqual(before);
  });

  test("benchmark LLM-only mode rejects provider failures instead of using deterministic extraction", async () => {
    const { invokeParamExtractor } = await import("../../../dist/agent-langgraph/param-extractor.js");

    await expect(invokeParamExtractor({
      message: "A two-story frame uses Q355 steel.",
      existingState: undefined,
      locale: "en",
      plugin: beamPlugin,
      requireLlmResult: true,
      llm: {
        invoke: async () => {
          throw new Error("terminated");
        },
      },
    })).rejects.toThrow("LLM_PARAM_EXTRACTOR_INFRASTRUCTURE_ERROR");
  });

  test("benchmark LLM-only mode counts unusable extraction output as a model failure", async () => {
    const { invokeParamExtractor } = await import("../../../dist/agent-langgraph/param-extractor.js");

    await expect(invokeParamExtractor({
      message: "A simply supported beam spans 6 m.",
      existingState: undefined,
      locale: "en",
      plugin: beamPlugin,
      requireLlmResult: true,
      llm: {
        invoke: async () => ({ content: "I cannot provide JSON." }),
      },
    })).rejects.toThrow("LLM_PARAM_EXTRACTOR_INVALID_OUTPUT");
  });

  test("reports provider finish reason and response length for unusable output", async () => {
    const { invokeParamExtractor } = await import("../../../dist/agent-langgraph/param-extractor.js");

    await expect(invokeParamExtractor({
      message: "A three-dimensional frame has several stories and bays.",
      existingState: undefined,
      locale: "en",
      plugin: beamPlugin,
      requireLlmResult: true,
      llm: {
        invoke: async () => ({
          content: '{"draftPatch":{"storyCount":3',
          response_metadata: { finish_reason: "length" },
          additional_kwargs: { reasoning_content: "reasoning only" },
        }),
      },
    })).rejects.toThrow(
      "finishReason=length; contentLength=29; reasoningContentLength=14",
    );
  });

  test("passes the enclosing abort signal to the extraction LLM", async () => {
    const { invokeParamExtractor } = await import("../../../dist/agent-langgraph/param-extractor.js");
    const controller = new AbortController();
    let receivedSignal;

    await invokeParamExtractor({
      message: "A simply supported beam spans 6 m.",
      existingState: undefined,
      locale: "en",
      plugin: beamPlugin,
      signal: controller.signal,
      llm: {
        invoke: async (_prompt, options) => {
          receivedSignal = options?.signal;
          return { content: '{"lengthM":6}' };
        },
      },
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  test("reports provider token usage from the nested extraction call", async () => {
    const { invokeParamExtractor } = await import("../../../dist/agent-langgraph/param-extractor.js");
    const usages = [];

    await invokeParamExtractor({
      message: "A simply supported beam spans 6 m.",
      existingState: undefined,
      locale: "en",
      plugin: beamPlugin,
      onUsage: (usage) => usages.push(usage),
      llm: {
        invoke: async () => ({
          content: '{"lengthM":6}',
          usage_metadata: {
            input_tokens: 90,
            output_tokens: 10,
            total_tokens: 100,
          },
        }),
      },
    });

    expect(usages).toEqual([{
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
    }]);
  });

  test("builds one direct prompt with embedded skill guidance", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "zh",
      { inferredType: "beam", lengthM: 6 },
      beamPlugin,
      "简支梁，跨度20m，均布荷载10kN/m",
    );

    expect(prompt).toContain("当前结构技能参数说明");
    expect(prompt).toContain("\"skillId\": \"beam\"");
    expect(prompt).toContain("已有 draftState");
    expect(prompt).toMatch(/"lengthM":\s*6/);
    expect(prompt).toContain("简支梁，跨度20m，均布荷载10kN/m");
    expect(prompt).toContain("restraints 顺序严格为 [ux,uy,uz,rx,ry,rz]");
    expect(prompt).toContain("沿全局 X 向可滑动的滚动支座为 [false,true,true,false,false,false]");
    expect(prompt).toContain("不得补写用户未提供的荷载单位或荷载种类");
    expect(prompt).toContain("无法区分总力、线荷载或面荷载");
    expect(prompt).toContain("源面荷载及其按受荷宽度折算得到的线荷载不是两个独立荷载");
    expect(prompt).toContain('"factors":{"additionalProperties":{"type":"number"}');
    expect(prompt).not.toContain("get_skill_parameter_info");
  });

  test("defines the canonical support restraints in the English extraction prompt", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "en",
      { inferredType: "double-span-beam" },
      beamPlugin,
      "The left support is pinned and the others are rollers free in global X.",
    );

    expect(prompt).toContain("restraints are exactly [ux,uy,uz,rx,ry,rz]");
    expect(prompt).toContain("a pin is [true,true,true,false,false,false]");
    expect(prompt).toContain("a roller free in global X is [false,true,true,false,false,false]");
    expect(prompt).toContain("Never supply a load unit or load kind that the user did not provide");
    expect(prompt).toContain("does not distinguish total force, line load, or area load");
    expect(prompt).toContain("A source area load and the line load derived from it by tributary width are not independent loads");
    expect(prompt).toContain('"factors":{"additionalProperties":{"type":"number"}');
  });

  test("includes structured semantic seismic workflow contract in extraction prompt", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "zh",
      { inferredType: "frame", storyCount: 3 },
      {
        ...beamPlugin,
        id: "concrete-frame",
        structureType: "frame",
        markdownByStage: {
          draft: "中国抗震设计意图输出 skillState.seismicWorkflow，不能用关键词或正则决定方法。",
        },
      },
      "三层混凝土框架，按中国抗震做反应谱和时程分析，8度，第三组，III类场地",
    );

    expect(prompt).toContain('"seismicWorkflow"');
    expect(prompt).toContain('"methodPreference": "auto|response_spectrum|time_history|pushover|elastic_plastic_time_history"');
    expect(prompt).toContain('"groundMotionZonation"');
    expect(prompt).toContain('"localCatalog"');
    expect(prompt).toContain('"seismicMemberEvidence"');
    expect(prompt).toContain('"strongShearWeakBending"');
    expect(prompt).toContain('"steelSeismicDetailing"');
    expect(prompt).toContain("基于整句语义输出 skillState.seismicWorkflow");
    expect(prompt).toContain("不要用关键词或正则匹配决定 response_spectrum/time_history/pushover/elastic_plastic_time_history");
    expect(prompt).toContain("不要根据城市名或自然语言自行编造烈度");
    expect(prompt).toContain("不要由 LLM 判断条文通过或失败");
  });

  test("omits serialized undefined checkpoint noise from existing draft state", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "zh",
      {
        inferredType: "beam",
        lengthM: 6,
        loadKN: { lc: 2, type: "undefined" },
        engineeringDraft: {
          structureType: "beam",
          geometry: {
            lengthM: 6,
            heightM: { lc: 2, type: "undefined" },
          },
          loads: { lc: 2, type: "undefined" },
        },
      },
      beamPlugin,
      "荷载10kN",
    );

    expect(prompt).toMatch(/"lengthM":\s*6/);
    expect(prompt).not.toContain("\"lc\": 2");
    expect(prompt).not.toContain("\"type\": \"undefined\"");
    expect(prompt).not.toContain("\"loadKN\"");
  });

  test("omits previous diagnostics from existing draft state in clarification prompts", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "zh",
      {
        inferredType: "truss",
        lengthM: 15,
        skillState: {
          trussTopology: "warren",
          engineeringDraft: {
            structureType: "truss",
            geometry: { lengthM: 15 },
          },
          extractionSource: "engineering-draft",
          invalidDraftFields: ["loadKN"],
        },
        updatedAt: 123,
        skillId: "truss",
        structuralTypeKey: "truss",
        coordinateSemantics: "global-z-up",
        draftIssues: [{
          field: "loadKN",
          severity: "ambiguous",
          reason: "荷载缺失",
        }],
      },
      {
        ...beamPlugin,
        id: "truss",
        structureType: "truss",
        markdownByStage: {
          draft: "- `每个上弦节点荷载 10 kN` maps to `engineeringDraft.loads` and `loadKN: 10`.",
        },
      },
      "每个上弦节点10kN",
    );
    const stateSection = prompt.split("已有 draftState:\n")[1].split("\n\n用户消息:")[0];

    expect(stateSection).toContain("\"lengthM\": 15");
    expect(stateSection).toContain("\"trussTopology\": \"warren\"");
    expect(stateSection).not.toContain("invalidDraftFields");
    expect(stateSection).not.toContain("draftIssues");
    expect(stateSection).not.toContain("engineeringDraft");
    expect(stateSection).not.toContain("extractionSource");
    expect(stateSection).not.toContain("updatedAt");
    expect(stateSection).not.toContain("skillId");
    expect(stateSection).not.toContain("structuralTypeKey");
    expect(stateSection).not.toContain("coordinateSemantics");
    expect(prompt).toContain("如果当前用户消息是在回答追问或更正缺失/无效字段");
  });

  test("repeats draft-stage guidance near the user message", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "zh",
      { inferredType: "truss", lengthM: 15 },
      {
        ...beamPlugin,
        id: "truss",
        structureType: "truss",
        markdownByStage: {
          draft: "- top chord node load maps to `loadKN` and `loadPosition: top-nodes`.",
        },
      },
      "每个上弦节点10kN",
    );

    expect(prompt.indexOf("当前 draft 阶段重点说明")).toBeGreaterThan(prompt.indexOf("规则："));
    expect(prompt.indexOf("已有 draftState")).toBeGreaterThan(prompt.indexOf("top chord node load maps"));
  });

  test("builds a focused clarification prompt for missing fields", async () => {
    const { buildParamExtractorPrompt } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const prompt = buildParamExtractorPrompt(
      "zh",
      { inferredType: "truss", lengthM: 15, heightM: 3 },
      {
        ...beamPlugin,
        id: "truss",
        structureType: "truss",
        markdownByStage: {
          draft: "- top chord node load maps to `loadKN` and `loadPosition: top-nodes`.",
        },
      },
      "每个上弦节点10kN",
      ["loadKN"],
    );

    expect(prompt).toContain("正在处理多轮澄清回答");
    expect(prompt).toContain("本轮重点字段：[\"loadKN\"]");
    expect(prompt).toContain("用户最新回答");
    expect(prompt).toContain("每个上弦节点10kN");
    expect(prompt).toContain("only newly supplied or corrected fields");
  });

  test("parses direct parameter JSON and draftPatch-wrapped JSON", async () => {
    const { parseDraftPatchFromContent } = await import("../../../dist/agent-langgraph/param-extractor.js");

    expect(parseDraftPatchFromContent('{"lengthM":20,"loadKN":10}')).toEqual({
      lengthM: 20,
      loadKN: 10,
    });
    expect(parseDraftPatchFromContent('{"draftPatch":{"lengthM":20,"loadKN":10}}')).toEqual({
      lengthM: 20,
      loadKN: 10,
    });
    expect(parseDraftPatchFromContent(JSON.stringify({
      draftPatch: { lengthM: 20 },
      skillState: { invalidDraftFields: ["loadKN"] },
      draftIssues: [{
        field: "loadKN",
        severity: "ambiguous",
        reason: "Negative load sign may represent uplift.",
      }],
    }))).toEqual({
      lengthM: 20,
      skillState: { invalidDraftFields: ["loadKN"] },
      draftIssues: [{
        field: "loadKN",
        severity: "ambiguous",
        reason: "Negative load sign may represent uplift.",
      }],
    });
  });

  test("preserves semantic seismic workflow from parsed skillState", async () => {
    const { parseDraftPatchFromContent } = await import("../../../dist/agent-langgraph/param-extractor.js");
    const seismicWorkflow = {
      methodPreference: "time_history",
      designBasis: {
        siteSeismic: { intensity: 8, designGroup: "3", siteCategory: "III" },
      },
      groundMotionSet: { requiredCount: 3 },
      directions: ["x", "y"],
    };

    expect(parseDraftPatchFromContent(JSON.stringify({
      draftPatch: { storyCount: 3 },
      skillState: { seismicWorkflow },
    }))).toEqual({
      storyCount: 3,
      skillState: { seismicWorkflow },
    });
  });

  test("wraps top-level semantic engineering draft JSON", async () => {
    const { parseDraftPatchFromContent } = await import("../../../dist/agent-langgraph/param-extractor.js");

    const semanticJson = JSON.stringify({
      structureType: "column",
      geometry: { heightM: 4.2 },
      loads: [
        { kind: "nodal", magnitude: 600, unit: "kN", direction: "gravity" },
      ],
    });

    expect(parseDraftPatchFromContent(semanticJson)).toEqual({
      engineeringDraft: {
        structureType: "column",
        geometry: { heightM: 4.2 },
        loads: [
          { kind: "nodal", magnitude: 600, unit: "kN", direction: "gravity" },
        ],
      },
    });
  });
});


test.each(['en', 'zh'])('both prompt modes forbid self-weight questions and preserve section provenance (%s)', async locale => {
  const { buildParamExtractorPrompt } = await import('../../../dist/agent-langgraph/param-extractor.js');
  for (const patchMode of [false, true]) {
    const prompt = buildParamExtractorPrompt(locale, { inferredType: 'beam', engineeringDraft: {} }, beamPlugin, 'Q235', [], patchMode);
    expect(prompt).toContain('If self-weight is unmentioned, do not ask');
    expect(prompt).toContain('未提及自重时不追问');
    expect(prompt).toContain('shape ONLY');
    expect(prompt).toContain('never tool-retrieved');
    expect(prompt).toContain('不能声称工具检索');
    expect(prompt).toContain('NOT computable before the user confirms');
    expect(prompt).toContain('确认前不能计算');
    expect(prompt).toContain('sectionRecords[].extra, alongside shape and properties');
    expect(prompt).toContain('与shape和properties同级');
    if (patchMode) {
      expect(prompt).toContain('Never clear identity or evidence (including extra.source and extra.provenance)');
      expect(prompt).toContain('confirmation updates provenance.shape="user"');
      expect(prompt).toContain('materials:[{id,name,family,grade,E,nu,rho,extra}]');
    }
  }
});
