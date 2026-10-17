import { resolveCodeCheckRule } from './registry.js';
import type { CodeCheckDomainInput } from './types.js';
import type { CodeCheckClient } from './rule.js';
import type { ExecutionRequestOptions } from '../analysis/types.js';
import { withGB50011CodeCheckMetadata } from './gb50011/metadata.js';
import { withConfirmedReinforcement, extractElementIds, asRecord, extractAnalysisSummary, extractElementContextById, extractModelSummary, appendGlobalSeismicElement, isGB50011DesignCode } from './input-context.js';
import { extractElementDataForCodeCheck } from './input-element-data.js';

export {
  listCodeCheckRuleProviders,
  resolveCodeCheckDesignCodeFromSkillIds,
} from './registry.js';

export function buildCodeCheckInput(options: {
  traceId: string;
  designCode: string;
  model: Record<string, unknown>;
  analysis: unknown;
  analysisParameters: Record<string, unknown>;
  postprocessedResult?: Record<string, unknown>;
  codeCheckElements?: string[];
}): CodeCheckDomainInput {
  const model = withConfirmedReinforcement(options.model);
  // elementData: 合并 OpenSees 内力 + 模型截面/材料, 供 Python code-check 层真算
  const elementData = extractElementDataForCodeCheck(model, options.analysis);

  const elements = options.codeCheckElements?.length ? options.codeCheckElements : extractElementIds(options.model);
  const context: CodeCheckDomainInput['context'] = {
    source: {
      ...asRecord(asRecord(options.analysis)['meta']),
      resultKey: asRecord(options.analysis)['selectedResultKey'] ?? asRecord(asRecord(options.analysis)['selection'])['key'],
      designCode: options.designCode,
      modelId: options.traceId,
    },
    analysisSummary: extractAnalysisSummary(options.analysis),
    // Utilizations must be computed from the bound model and result vectors.
    // Caller-supplied ratios cannot override missing forces or design properties.
    utilizationByElement: {},
    elementContextById: extractElementContextById(model),
    modelSummary: extractModelSummary(model),
    elementData,
  };

  return {
    modelId: options.traceId,
    code: options.designCode,
    elements: appendGlobalSeismicElement(elements, options.designCode, options.analysis),
    context: isGB50011DesignCode(options.designCode)
      ? withGB50011CodeCheckMetadata(context)
      : context,
  };
}

export async function executeCodeCheckDomain(
  engineClient: CodeCheckClient,
  input: CodeCheckDomainInput,
  engineId?: string,
  requestOptions?: ExecutionRequestOptions,
): Promise<unknown> {
  const rule = resolveCodeCheckRule(input.code);
  return rule.execute(engineClient, input, engineId, requestOptions);
}
