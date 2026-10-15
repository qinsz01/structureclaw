import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { prisma } from '../dist/utils/database.js';
import { contentHash, modelHash } from '../dist/engineering/model-state.js';
import { executeAnalysisRun } from '../dist/engineering/analysis-runs.js';
import {
  AnalysisService,
  buildDirectAnalysisModelForCodeCheck,
  buildDirectSeismicReport,
  resolveDirectChinaSeismicDesignCode,
  shouldRunDirectSeismicCodeCheck,
  withDirectModelCoordinateContract,
} from '../dist/services/analysis.js';

const originalFindUnique = prisma.analysis.findUnique;
const originalUpdate = prisma.analysis.update;
const originalUpdateMany = prisma.analysis.updateMany;

afterEach(() => {
  prisma.analysis.findUnique = originalFindUnique;
  prisma.analysis.update = originalUpdate;
  prisma.analysis.updateMany = originalUpdateMany;
  jest.restoreAllMocks();
});

describe('AnalysisService direct China seismic workflow', () => {
  test('rejects untyped legacy direct models instead of guessing 2D or 3D from coordinates', () => {
    expect(() => withDirectModelCoordinateContract({
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 0 },
        { id: 'N2', x: 0, y: 4, z: 0 },
      ],
      elements: [{ id: 'E1', type: 'column', nodes: ['N1', 'N2'] }],
    })).toThrow(/cannot be classified safely/);
  });

  test('detects when direct seismic analysis should run GB50011 code-check', () => {
    expect(shouldRunDirectSeismicCodeCheck('seismic', {
      seismicWorkflow: { methodPreference: 'response_spectrum' },
    })).toBe(true);
    expect(shouldRunDirectSeismicCodeCheck('seismic', {
      autoCodeCheck: false,
      seismicWorkflow: { methodPreference: 'response_spectrum' },
    })).toBe(false);
    expect(shouldRunDirectSeismicCodeCheck('static', {
      seismicWorkflow: { methodPreference: 'response_spectrum' },
    })).toBe(false);
    expect(shouldRunDirectSeismicCodeCheck('seismic', {})).toBe(false);
  });

  test('builds a code-check model from the persisted analysis model', () => {
    const model = buildDirectAnalysisModelForCodeCheck({
      coordinateSystem: {
        semantics: 'global-z-up',
        version: 1,
        dimension: '2d',
        plane: 'xz',
        dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
      },
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 0 },
        { id: 'N2', x: 1, y: 0, z: 0 },
      ],
      elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'] }],
      materials: [{ id: 'C30' }],
      sections: [{ id: 'S1' }],
    });

    expect(model).toMatchObject({
      schemaVersion: '2.2.0',
      schema_version: '2.2.0',
      coordinate_system: {
        semantics: 'global-z-up',
        version: 1,
        dimension: '2d',
        plane: 'xz',
        dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
      },
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 0 },
        { id: 'N2', x: 1, y: 0, z: 0 },
      ],
      elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'] }],
      materials: [{ id: 'C30' }],
      sections: [{ id: 'S1' }],
      load_cases: [],
      load_combinations: [],
    });
  });

  test('resolves only GB50011-compatible design codes for direct China seismic checks', () => {
    expect(resolveDirectChinaSeismicDesignCode({})).toBe('GB/T 50011-2010-2024');
    expect(resolveDirectChinaSeismicDesignCode({ designCode: 'GB 55002+GB/T 50011' }))
      .toBe('GB 55002+GB/T 50011');
    expect(() => resolveDirectChinaSeismicDesignCode({ designCode: 'GB50017' }))
      .toThrow(/GB50011-compatible designCode/);
  });

  test('builds a direct seismic report from analysis and GB50011 code-check results', () => {
    const report = buildDirectSeismicReport({
      analysisName: 'direct seismic',
      analysisType: 'seismic',
      analysisResults: {
        success: true,
        data: {
          workflowInputMode: 'structured_seismic_workflow',
          designBasis: {
            codeBasis: [
              { code: 'GB 55002-2021' },
              { code: 'GB/T 50011-2010', edition: '2024 partial revision' },
            ],
          },
          methodDecision: { selectedMethods: ['response_spectrum'] },
        },
      },
      codeCheck: {
        data: {
          summary: { total: 4, passed: 3, failed: 0, warnings: 1 },
          details: [{
            elementId: '__global_seismic__',
            checks: [{ item: 'overall-final-compliance', status: 'pass', clause: 'GB 55002-2021' }],
          }],
        },
      },
      parameters: {
        locale: 'en',
        intent: 'Run China seismic design workflow',
      },
    });

    expect(report.summary).toContain('Code checks passed 3 / 4, failed 0, warnings 1');
    expect(report.json).toMatchObject({
      reportSchemaVersion: '1.1.0',
      intent: 'Run China seismic design workflow',
      analysisType: 'seismic',
      meta: {
        reportSkillId: 'report-export-builtin',
        reportSource: 'direct-analysis-api',
      },
    });
    expect(report.markdown).toContain('## Seismic Design');
    expect(report.markdown).toContain('structured seismicWorkflow');
  });

  test('persists GB50011 code-check and report output with direct structured seismic analysis results', async () => {
    const analysisResult = {
      success: true,
      data: {
        analysisMode: 'opensees_china_seismic_workflow',
        workflowInputMode: 'structured_seismic_workflow',
        designBasis: { siteSeismic: { intensity: 8 } },
        methodDecision: { selectedMethods: ['response_spectrum'] },
        envelope: { maxStoryDriftRatio: 0.001 },
      },
    };
    const codeCheckResult = {
      code: 'GB50011',
      status: 'success',
      summary: { total: 2, passed: 2, failed: 0, warnings: 0 },
    };
    const persistedModel = {
      coordinateSystem: {
        semantics: 'global-z-up',
        version: 1,
        dimension: '2d',
        plane: 'xz',
        dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
      },
      nodes: [
        { id: 'N1', x: 0, y: 0, z: 0 },
        { id: 'N2', x: 1, y: 0, z: 0 },
      ],
      elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'] }],
      materials: [],
      sections: [],
    };
    const parameters = {
      seismicWorkflow: { methodPreference: 'response_spectrum' },
    };
    const fingerprint = modelHash(buildDirectAnalysisModelForCodeCheck(persistedModel));
    analysisResult.runId = 'seismic-run';
    analysisResult.meta = {
      runId: 'seismic-run', modelHash: fingerprint,
      settingsHash: contentHash({ type: 'seismic', parameters }),
    };

    prisma.analysis.findUnique = jest.fn().mockResolvedValue({
      id: 'analysis-1',
      name: 'direct seismic task',
      type: 'seismic',
      parameters,
      model: persistedModel,
    });
    prisma.analysis.update = jest.fn().mockImplementation(async ({ data }) => ({
      id: 'analysis-1',
      ...data,
    }));
    prisma.analysis.updateMany = jest.fn().mockResolvedValue({count:1});

    const service = new AnalysisService();
    service.executionService.analyze = jest.fn().mockResolvedValue(analysisResult);
    service.codeCheckExecutionService.codeCheck = jest.fn().mockResolvedValue(codeCheckResult);

    const updated = await service.runAnalysis('analysis-1');

    expect(service.codeCheckExecutionService.codeCheck).toHaveBeenCalledTimes(1);
    const codeCheckPayload = service.codeCheckExecutionService.codeCheck.mock.calls[0][0];
    expect(codeCheckPayload).toMatchObject({
      code: 'GB50011',
      context: {
        analysisSummary: {
          analysisMode: 'opensees_china_seismic_workflow',
          workflowInputMode: 'structured_seismic_workflow',
        },
        displayCode: 'GB 55002-2021 + GB/T 50011-2010 (2024 partial revision)',
        codeVersion: 'v2-global-seismic-gb55002-gbt50011-2024',
        source: { runId: 'seismic-run', modelHash: fingerprint, analysisId: 'analysis-1' },
      },
    });
    expect(codeCheckPayload.elements).toEqual(expect.arrayContaining(['E1', '__global_seismic__']));
    expect(updated.results).toMatchObject({
      ...analysisResult,
      codeCheck: codeCheckResult,
      report: {
        summary: '分析类型 seismic，分析成功，校核通过 2 / 2，失败 0，警告 0。',
        json: {
          reportSchemaVersion: '1.1.0',
          analysisType: 'seismic',
          codeCheck: codeCheckResult,
          meta: {
            reportSkillId: 'report-export-builtin',
            reportSource: 'direct-analysis-api',
          },
        },
        markdown: expect.stringContaining('## 抗震专项'),
      },
    });
    expect(prisma.analysis.update).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: 'analysis-1', status:'running', results:{equals:expect.objectContaining({requestId:expect.any(String)})} }),
      data: expect.objectContaining({
        status: 'completed',
        results: expect.objectContaining({
          ...analysisResult,
          codeCheck: expect.objectContaining(codeCheckResult),
          report: expect.objectContaining({
            summary: '分析类型 seismic，分析成功，校核通过 2 / 2，失败 0，警告 0。',
            markdown: expect.stringContaining('## 抗震专项'),
          }),
        }),
      }),
    });
  });

  test('fails direct structured seismic analysis when an incompatible design code is requested', async () => {
    const analysisResult = {
      success: true,
      data: {
        analysisMode: 'opensees_china_seismic_workflow',
        workflowInputMode: 'structured_seismic_workflow',
        designBasis: { siteSeismic: { intensity: 8 } },
        methodDecision: { selectedMethods: ['response_spectrum'] },
        envelope: { maxStoryDriftRatio: 0.001 },
      },
    };

    prisma.analysis.findUnique = jest.fn().mockResolvedValue({
      id: 'analysis-1',
      name: 'direct seismic task',
      type: 'seismic',
      parameters: {
        seismicWorkflow: { methodPreference: 'response_spectrum' },
        designCode: 'GB50017',
      },
      model: {
        coordinateSystem: {
          semantics: 'global-z-up',
          version: 1,
          dimension: '2d',
          plane: 'xz',
          dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'],
        },
        nodes: [],
        elements: [],
        materials: [],
        sections: [],
      },
    });
    prisma.analysis.update = jest.fn().mockImplementation(async ({ data }) => ({
      id: 'analysis-1',
      ...data,
    }));
    prisma.analysis.updateMany = jest.fn().mockResolvedValue({count:1});

    const service = new AnalysisService();
    service.executionService.analyze = jest.fn().mockResolvedValue(analysisResult);
    service.codeCheckExecutionService.codeCheck = jest.fn();

    await expect(service.runAnalysis('analysis-1')).rejects.toThrow(/GB50011-compatible designCode/);
    expect(service.codeCheckExecutionService.codeCheck).not.toHaveBeenCalled();
    expect(prisma.analysis.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id:'analysis-1',status:'running',results:{equals:expect.objectContaining({requestId:expect.any(String)})} }),
      data: expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('GB50011-compatible designCode'),
      }),
    });
  });

  test('a running task cannot launch a second solver job', async () => {
    prisma.analysis.findUnique = jest.fn().mockResolvedValue({id:'busy',type:'static',parameters:{},model:{updatedAt:new Date()}});
    prisma.analysis.updateMany = jest.fn().mockResolvedValue({count:0});
    const service = new AnalysisService();
    service.executionService.analyze = jest.fn();
    await expect(service.runAnalysis('busy')).rejects.toThrow('ANALYSIS_TASK_RUNNING_OR_CHANGED');
    expect(service.executionService.analyze).not.toHaveBeenCalled();
  });
});

describe('AnalysisService persisted-run code-check boundary', () => {
  const request = { modelId: 'model-1', analysisId: 'analysis-1', runId: '', code: 'GB50017', elements: ['E1'] };
  async function fixture() {
    const physicalModel = buildDirectAnalysisModelForCodeCheck({
      id: 'model-1',
      coordinateSystem: { semantics: 'global-z-up', version: 1, dimension: '2d', plane: 'xz', dof_order: ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] },
      nodes: [{ id: 'N1', x: 0, y: 0, z: 0 }, { id: 'N2', x: 4, y: 0, z: 0 }],
      elements: [{ id: 'E1', type: 'beam', nodes: ['N1', 'N2'], material: 'S', section: 'R' }],
      materials: [{ id: 'S', E: 206000 }], sections: [{ id: 'R', type: 'rectangle', shape: { b: 100, h: 200 } }],
      load_cases: [{ id: 'D', loads: [] }, { id: 'L', loads: [] }], load_combinations: [],
    });
    const parameters = {};
    const results = await executeAnalysisRun({ type: 'static', model: physicalModel, parameters },
      async input => ({ success: true, data: { analysisMode: input.parameters.loadCaseIds[0] }, meta: { engine: 'test' } }), async () => {});
    const row = { id: 'analysis-1', modelId: 'model-1', type: 'static', status: 'completed', parameters, results,
      model: { id: 'model-1', coordinateSystem: physicalModel.coordinate_system, physicalModel } };
    prisma.analysis.findUnique = jest.fn().mockResolvedValue(row);
    prisma.analysis.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new AnalysisService();
    service.codeCheckExecutionService.codeCheck = jest.fn().mockImplementation(async payload => ({
      code: 'GB50017', status: 'success', completionStatus: payload.context.analysisSummary.analysisMode === 'D' ? 'complete' : 'incomplete',
      complianceStatus: payload.context.analysisSummary.analysisMode === 'D' ? 'pass' : 'incomplete',
      summary: { total: 1, passed: payload.context.analysisSummary.analysisMode === 'D' ? 1 : 0,
        inputRequired: payload.context.analysisSummary.analysisMode === 'D' ? 0 : 1 }, details: [],
    }));
    return { service, row, params: { ...request, runId: results.runId } };
  }

  test('requires explicit analysis and run identity before querying or executing', async () => {
    const service = new AnalysisService();
    prisma.analysis.findUnique = jest.fn();
    await expect(service.codeCheck({ modelId: 'model-1', code: 'GB50017', elements: [] }))
      .rejects.toThrow('ANALYSIS_ID_AND_RUN_ID_REQUIRED');
    expect(prisma.analysis.findUnique).not.toHaveBeenCalled();
  });

  test('checks every real case independently and retains the model/run/case source', async () => {
    const { service, row, params } = await fixture();
    const result = await service.codeCheck(params);
    expect(prisma.analysis.findUnique).toHaveBeenCalledWith({ where: { id: 'analysis-1' }, include: { model: true } });
    expect(service.codeCheckExecutionService.codeCheck).toHaveBeenCalledTimes(2);
    const payloads = service.codeCheckExecutionService.codeCheck.mock.calls.map(call => call[0]);
    expect(payloads.map(payload => payload.context.analysisSummary.analysisMode)).toEqual(['D', 'L']);
    expect(payloads.map(payload => payload.context.source.resultKey)).toEqual(['case:D', 'case:L']);
    for (const payload of payloads) {
      expect(payload.context.source).toMatchObject({ runId: params.runId, modelHash: row.results.meta.modelHash, modelId: 'model-1', analysisId: 'analysis-1' });
      expect(payload.context.elementData.E1).toBeDefined();
    }
    expect(result).toMatchObject({ completionStatus: 'incomplete', complianceStatus: 'incomplete',
      summary: { total: 2, passed: 1, inputRequired: 1 }, meta: { runId: params.runId, analysisId: 'analysis-1' } });
    expect(Object.keys(result.checkResults)).toEqual(['case:D', 'case:L']);
    expect(prisma.analysis.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: row.id, status:'completed', results: { equals: row.results }, parameters:{equals:row.parameters} }),
      data: { results: expect.objectContaining({ codeCheck: result }) },
    });
  });

  test('direct HTTP/CLI service rejects an absent serviceability case before executing checks', async () => {
    const {service,row,params} = await fixture();
    row.model.physicalModel.elements[0].design = {serviceability_result_keys:['case:TYPO']};
    row.results = await executeAnalysisRun({type:'static',model:row.model.physicalModel,parameters:row.parameters},
      async () => ({success:true,data:{}}),async () => {});
    params.runId = row.results.runId;
    await expect(service.codeCheck(params)).rejects.toThrow('SERVICEABILITY_RESULT_UNAVAILABLE');
    expect(service.codeCheckExecutionService.codeCheck).not.toHaveBeenCalled();
  });

  test('a late check cannot replace results published while it was executing', async () => {
    const { service, params } = await fixture();
    prisma.analysis.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.codeCheck(params)).rejects.toThrow('DESIGN_RUN_SUPERSEDED');
    expect(service.codeCheckExecutionService.codeCheck).toHaveBeenCalledTimes(2);
  });

  test.each([
    { loadCombinationId: 'U' }, { load_combination_id: 'U' }, { combinationId: 'U' },
    { combinationIds: ['U'] }, { load_case_ids: ['D'], loadCases: [] },
  ])('uses canonical settings provenance when persisted parameters use %j', async (parameters) => {
    const { service, row, params } = await fixture();
    row.parameters = parameters;
    row.model.physicalModel.load_combinations = [{ id: 'U', factors: { D: 1.2, L: 1.4 } }];
    row.results = await executeAnalysisRun({ type: 'static', model: row.model.physicalModel, parameters },
      async input => ({ success: true, data: { analysisMode: input.parameters.loadCombinationId ?? input.parameters.loadCaseIds[0] } }), async () => {});
    params.runId = row.results.runId;
    const result = await service.codeCheck(params);
    expect(result.meta.runId).toBe(row.results.runId);
    expect(service.codeCheckExecutionService.codeCheck).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.checkResults)).toEqual([parameters.load_case_ids ? 'case:D' : 'combination:U']);
  });

  test.each([
    ['injected context', (_row, params) => { params.context = { utilizationByElement: { E1: 0.01 } }; }, 'CODE_CHECK_CONTEXT_OVERRIDE_UNSUPPORTED'],
    ['wrong model', (row) => { row.modelId = 'other'; }, 'ANALYSIS_MODEL_NOT_FOUND'],
    ['wrong run', (_row, params) => { params.runId = 'old'; }, 'CURRENT_ANALYSIS_RUN_REQUIRED'],
    ['unfinished analysis', (row) => { row.status = 'running'; }, 'CURRENT_ANALYSIS_RUN_REQUIRED'],
    ['failed run', (row) => { row.results.success = false; }, 'CURRENT_ANALYSIS_RUN_REQUIRED'],
    ['changed model', (row) => { row.model.physicalModel.nodes[1].x = 5; }, 'ANALYSIS_MODEL_MISMATCH'],
    ['changed settings', (row) => { row.parameters = { loadCaseIds: ['D'] }; }, 'ANALYSIS_SETTINGS_MISMATCH'],
    ['unknown member', (_row, params) => { params.elements = ['missing']; }, 'CODE_CHECK_ELEMENT_NOT_FOUND'],
    ['foreign child run', (row) => { row.results.results['case:D'].meta.runId = 'foreign'; }, 'ANALYSIS_RESULT_PROVENANCE_MISMATCH'],
  ])('rejects %s without executing a check', async (_name, change, error) => {
    const { service, row, params } = await fixture();
    change(row, params);
    await expect(service.codeCheck(params)).rejects.toThrow(error);
    expect(service.codeCheckExecutionService.codeCheck).not.toHaveBeenCalled();
  });
});
