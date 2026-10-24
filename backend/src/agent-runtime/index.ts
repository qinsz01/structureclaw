import { listProviders, type ProviderDefinition } from '../providers/catalog.js';
import { providerAccessError } from '../providers/access.js';
import { prepareEngineeringReport, finishEngineeringReport } from './engineering-report.js';
import { computeDraftMissing, describeCriticalMissing } from './draft-readiness.js';
import { assertResolvedInput } from '../engineering/input-evidence.js';
import type { SectionEvidence } from '../engineering/section-evidence.js';
import { currentRunPolicy, requestRecovery, recordRunEvent } from '../runtime/run-context.js';
import type { AppLocale } from '../shared/locale.js';
import type { LlmTokenUsage, StructureClawChatModel } from '../utils/llm.js';
import {
  buildCodeCheckInput,
  executeCodeCheckDomain,
} from '../agent-skills/code-check/entry.js';
import { resolveCodeCheckRule } from '../agent-skills/code-check/registry.js';
import type { CodeCheckClient } from '../agent-skills/code-check/rule.js';
import { AgentSkillRegistry } from './registry.js';
import { matchesAnalysisContext } from '../providers/analysis-catalog.js';
import { AgentSkillLoader } from './loader.js';
import { invokeStructuralTypeRouter } from './llm-router.js';
import { buildDefaultReportNarrative } from './report-template.js';
import {
  loadSkillManifestsFromDirectorySync,
  resolveBuiltinSkillManifestRoot,
  toRuntimeSkillManifest,
  type LoadedSkillManifest,
} from '../skill-shared/skill-manifest-loader.js';
import type {
  AgentSkillBundle,
  AgentSkillPlugin,
  DraftState,
  StructuralTypeMatch,
  SkillReportNarrativeInput,
  SkillManifest,
} from '../shared/types/agent.js';

export type {
  AgentSkillBundle,
  AgentSkillPlugin,
  DraftExtraction,
  DraftFloorLoad,
  DraftLoadPosition,
  DraftLoadType,
  DraftState,
  DraftSupportType,
  FrameBaseSupportType,
  FrameDimension,
  InferredModelType,
  InteractionQuestion,
  StructuralTypeMatch,
  StructuralTypeKey,
  StructuralTypeSupportLevel,
  SkillDefaultProposal,
  SkillHandler,
  SkillManifest,
  SkillReportNarrativeInput,
} from '../shared/types/agent.js';

export class AgentSkillRuntime {
  private readonly registry: AgentSkillRegistry;
  readonly builtinSkillFileManifests: LoadedSkillManifest[];
  readonly builtinRuntimeSkillManifests: SkillManifest[];

  constructor(options?: { builtinSkillManifestRoot?: string; workspaceSkillRoot?: string }) {
    this.registry = new AgentSkillRegistry(new AgentSkillLoader({
      workspaceSkillRoot: options?.workspaceSkillRoot,
    }));
    const builtinSkillManifestRoot = options?.builtinSkillManifestRoot || resolveBuiltinSkillManifestRoot();
    this.builtinSkillFileManifests = loadSkillManifestsFromDirectorySync(builtinSkillManifestRoot).filter(manifest => manifest.domain === 'structure-type');
    this.builtinRuntimeSkillManifests = this.builtinSkillFileManifests.map((manifest) => toRuntimeSkillManifest(manifest));
  }

  listSkills(): AgentSkillBundle[] {
    return this.registry.listSkills();
  }

  /** Invalidate cached bundles and plugins so the next load re-scans disk. */
  invalidateSkillCache(): void {
    this.registry.invalidateCache();
  }

  /** Access the underlying registry for advanced queries. */
  getRegistry(): AgentSkillRegistry {
    return this.registry;
  }

  async listSkillManifests(): Promise<SkillManifest[]> {
    const plugins = await this.registry.listPlugins();
    const fileManifests = this.builtinRuntimeSkillManifests;
    const fileManifestIds = new Set(fileManifests.map((manifest) => manifest.id));
    return [
      ...fileManifests,
      ...plugins
        .filter((plugin) => !fileManifestIds.has(plugin.id))
        .map((plugin) => plugin.manifest),
    ];
  }

  listAnalysisSkillIds(): string[] {
    return this.listBuiltinAnalysisSkillManifests().map((skill) => skill.id);
  }

  listCodeCheckSkillIds(): string[] {
    return this.listBuiltinCodeCheckSkillManifests().map((skill) => skill.id);
  }

  isAnalysisSkillId(skillId: string | undefined): boolean {
    return typeof skillId === 'string' && this.listAnalysisSkillIds().includes(skillId);
  }

  isCodeCheckSkillId(skillId: string | undefined): boolean {
    return typeof skillId === 'string' && this.listCodeCheckSkillIds().includes(skillId);
  }

  resolveCodeCheckDesignCodeFromSkillIds(skillIds?: string[]): string | undefined {
    if (!Array.isArray(skillIds) || skillIds.length === 0) {
      return undefined;
    }
    const selectedSkillIds = new Set(skillIds);
    for (const skill of this.listBuiltinCodeCheckSkillManifests()) {
      if (selectedSkillIds.has(skill.id) && typeof skill.designCode === 'string' && skill.designCode.trim().length > 0) {
        return skill.designCode.trim().toUpperCase();
      }
    }
    return undefined;
  }

  resolveCodeCheckSkillId(designCode: string | undefined): string | undefined {
    if (typeof designCode !== 'string' || designCode.trim().length === 0) {
      return undefined;
    }
    const normalizedDesignCode = designCode.trim().toUpperCase();
    const manifestMatch = this.listBuiltinCodeCheckSkillManifests().find((skill) =>
      typeof skill.designCode === 'string' && skill.designCode.trim().toUpperCase() === normalizedDesignCode,
    )?.id;
    if (manifestMatch) {
      return manifestMatch;
    }
    try {
      return resolveCodeCheckRule(designCode).skillId;
    } catch {
      return undefined;
    }
  }

  resolvePreferredAnalysisSkill(options?: {
    analysisType?: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
    engineId?: string;
    skillIds?: string[];
    supportedModelFamilies?: string[];
  }) {
    const selectedSkillIds = new Set(
      Array.isArray(options?.skillIds)
        ? options.skillIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [],
    );
    const normalizedEngineId = typeof options?.engineId === 'string' && options.engineId.trim().length > 0
      ? options.engineId.trim()
      : undefined;
    const supportedFamilies = Array.isArray(options?.supportedModelFamilies)
      ? options.supportedModelFamilies
        .filter((family): family is string => typeof family === 'string' && family.trim().length > 0)
        .map((family) => family.trim().toLowerCase())
      : [];

    const matchesContext = (skill: ProviderDefinition): boolean => matchesAnalysisContext(skill, {
        analysisType: options?.analysisType,
        engineId: normalizedEngineId,
        supportedModelFamilies: supportedFamilies,
      });

    const analysisSkills = this.listBuiltinAnalysisSkillManifests();
    const matchedSelected = analysisSkills.filter((skill) => selectedSkillIds.has(skill.id) && matchesContext(skill));
    if (matchedSelected.length === 1) {
      return matchedSelected[0];
    }
    if (matchedSelected.length > 1) {
      // Multiple analysis skills selected: return highest-priority match as tiebreaker.
      // listBuiltinAnalysisSkillManifests() is already sorted by descending priority.
      return matchedSelected[0];
    }
    return analysisSkills.find(skill => matchesContext(skill) && !providerAccessError(skill.id));
  }

  async executeAnalysisSkill(options: {
    traceId: string;
    analysisType: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
    engineId?: string;
    model: Record<string, unknown>;
    parameters: Record<string, unknown>;
    analysisSkillId?: string;
    skillIds?: string[];
    supportedModelFamilies?: string[];
    postToEngineWithRetry: (
      path: string,
      input: Record<string, unknown>,
      retryOptions: { retries: number; traceId: string; tool: 'run_analysis'; signal?: AbortSignal },
    ) => Promise<{ data: unknown }>;
    signal?: AbortSignal;
  }): Promise<{
    input: {
      type: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
      engineId?: string;
      model: Record<string, unknown>;
      parameters: Record<string, unknown>;
    };
    result: Record<string, unknown>;
    skillId?: string;
  }> {
    const selectedSkill = (typeof options.analysisSkillId === 'string' && options.analysisSkillId.trim().length > 0)
      ? this.listBuiltinAnalysisSkillManifests().find((skill) => skill.id === options.analysisSkillId)
      : this.resolvePreferredAnalysisSkill({
        analysisType: options.analysisType,
        engineId: options.engineId,
        skillIds: options.skillIds,
        supportedModelFamilies: options.supportedModelFamilies,
      });

    const input = {
      type: options.analysisType,
      engineId: options.engineId || selectedSkill?.engineId,
      model: options.model,
      parameters: options.parameters,
    };
    // A lost solver response is not evidence that its job did not start.
    // The job record must be inspected rather than launching another solve.
    const retries = 0;
    const analyzed = await options.postToEngineWithRetry('/analyze', input, {
      retries,
      traceId: options.traceId,
      tool: 'run_analysis',
      signal: options.signal,
    });
    const result = (analyzed?.data ?? {}) as Record<string, unknown>;
    const existingMeta = result.meta && typeof result.meta === 'object'
      ? result.meta as Record<string, unknown>
      : {};
    if (selectedSkill) {
      result.meta = {
        ...existingMeta,
        analysisSkillId: selectedSkill.id,
        analysisSkillIds: [selectedSkill.id],
        analysisAdapterKey: selectedSkill.adapterKey,
        analysisType: options.analysisType,
      };
    } else if (result.meta === undefined && Object.keys(existingMeta).length > 0) {
      result.meta = existingMeta;
    }
    return {
      input,
      result,
      skillId: selectedSkill?.id,
    };
  }

  async executeCodeCheckSkill(options: {
    codeCheckClient: CodeCheckClient | unknown;
    traceId: string;
    designCode: string;
    model: Record<string, unknown>;
    analysis: unknown;
    analysisParameters: Record<string, unknown>;
    codeCheckElements?: string[];
    engineId?: string;
    codeCheckSkillId?: string;
    signal?: AbortSignal;
  }): Promise<{
    input: Record<string, unknown>;
    result: unknown;
    skillId?: string;
  }> {
    const skillId = (typeof options.codeCheckSkillId === 'string' && options.codeCheckSkillId.trim().length > 0)
      ? options.codeCheckSkillId
      : this.resolveCodeCheckSkillId(options.designCode);
    const input = buildCodeCheckInput({
      traceId: options.traceId,
      designCode: options.designCode,
      model: options.model,
      analysis: options.analysis,
      analysisParameters: options.analysisParameters,
      codeCheckElements: options.codeCheckElements,
    });
    const result = await executeCodeCheckDomain(
      options.codeCheckClient as CodeCheckClient,
      input,
      options.engineId,
      { signal: options.signal },
    );
    if (result && typeof result === 'object' && skillId) {
      const payload = result as Record<string, unknown>;
      const existingMeta = payload.meta && typeof payload.meta === 'object'
        ? payload.meta as Record<string, unknown>
        : {};
      payload.meta = {
        ...existingMeta,
        codeCheckSkillId: skillId,
      };
    }
    return {
      input,
      result,
      skillId,
    };
  }

  async executeValidationSkill(options: {
    model: Record<string, unknown>;
    engineId?: string;
    structureProtocolClient: {
      post: (path: string, payload: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }) => Promise<{ data: unknown }>;
    };
    signal?: AbortSignal;
  }): Promise<{
    input: { model: Record<string, unknown> };
    result: Record<string, unknown>;
    skillId: 'validation-structure-model';
  }> {
    const input = { model: options.model };
    const validated = await options.structureProtocolClient.post('/validate', {
      model: options.model,
      engineId: options.engineId,
    }, { signal: options.signal });
    return {
      input,
      result: (validated?.data ?? {}) as Record<string, unknown>,
      skillId: 'validation-structure-model',
    };
  }

  private listBuiltinAnalysisSkillManifests(): ProviderDefinition[] {
    return listProviders('solver').sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  private listBuiltinCodeCheckSkillManifests(): ProviderDefinition[] {
    return listProviders('design-code').sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  async executeReportSkill(options: {
    message: string;
    analysisType: 'static' | 'dynamic' | 'seismic' | 'nonlinear';
    normalizedModel?: unknown;
    analysis: unknown;
    codeCheck?: unknown;
    format: 'json' | 'markdown' | 'both';
    locale: AppLocale;
    draft?: DraftState;
    skillIds?: string[];
    evidenceBinding?: 'on' | 'off';
  }): Promise<{
    report: { summary: string; json: Record<string, unknown>; markdown?: string };
    skillId: 'report-export-builtin';
  }> {
    const prepared = prepareEngineeringReport(options);
    const narrative = options.format === 'json' ? undefined : await this.buildReportNarrative(
      prepared.narrativeInput, options.draft, options.skillIds);
    const report = finishEngineeringReport(prepared, narrative);
    return { report: { ...report, markdown: options.format === 'json' ? undefined : report.markdown },
      skillId: 'report-export-builtin' };
  }

  async detectStructuralTypeWithLlm(
    llm: StructureClawChatModel | null,
    message: string,
    locale: AppLocale,
    currentState?: DraftState,
    skillIds?: string[],
    signal?: AbortSignal,
    onUsage?: (usage: LlmTokenUsage) => void,
  ): Promise<StructuralTypeMatch> {
    signal?.throwIfAborted();
    if (!llm) {
      throw new Error('LLM_STRUCTURAL_ROUTER_REQUIRED: Structural interpretation requires a configured LLM; no keyword routing is available. / 结构语义判断需要已配置的大模型；不会改用关键词路由。');
    }
    const policy = currentRunPolicy();
    if (policy) skillIds = policy.activeSkillIds.filter(id => skillIds === undefined || skillIds.includes(id));
    if (policy?.routing.mode === 'fixed') {
      const plugin = await this.registry.resolvePluginForIdentifier(policy.routing.skillId, skillIds);
      if (!plugin) throw new Error('FIXED_SKILL_NOT_A_MODELING_PROVIDER: The configured modeling skill is unavailable. / 配置指定的建模技能不可用。');
      recordRunEvent({ kind: 'structural_routing', path: 'policy-fixed', skillId: plugin.id });
      return { key: plugin.manifest.structuralTypeKeys[0] ?? 'unknown', mappedType: plugin.structureType ?? 'unknown', skillId: plugin.id,
        supportLevel: 'supported', routingSource: 'policy-fixed' };
    }
    const enabled = await this.registry.resolveEnabledPlugins(skillIds);
    if (enabled.length === 0) {
      throw new Error('STRUCTURE_SKILL_UNAVAILABLE: No modeling skill is enabled for this request. / 本次请求未启用任何建模技能。');
    }
    if (enabled.length === 1 && enabled[0].id === 'generic') {
      // This is a configured provider binding, not a classification of the input text.
      recordRunEvent({ kind: 'structural_routing', path: 'scope-only', key: 'unknown', skillId: 'generic' });
      return { key: 'unknown', mappedType: 'unknown', skillId: 'generic', supportLevel: 'supported', routingSource: 'scope-selected' };
    }
    const currentPlugin = await this.registry.resolvePluginForState(currentState, skillIds);
    let infrastructureError: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      infrastructureError = undefined;
      try {
        const match = await invokeStructuralTypeRouter({
          llm, message, locale, currentState, currentPlugin, plugins: enabled, signal, onUsage,
        });
        if (match) {
          recordRunEvent({ kind: 'structural_routing', path: 'llm', attempt, key: match.key, skillId: match.skillId });
          return match;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof Error) || !error.message.startsWith('LLM_STRUCTURAL_ROUTER_INFRASTRUCTURE_ERROR:')) throw error;
        infrastructureError = error;
      }
      if (attempt === 1) requestRecovery('structural routing: retry unusable or failed LLM decision');
    }
    recordRunEvent({ kind: 'structural_routing', path: 'failed', reason: infrastructureError ? 'llm-unavailable' : 'invalid-llm-decision' });
    if (infrastructureError) throw infrastructureError;
    throw new Error('LLM_STRUCTURAL_ROUTER_INVALID_OUTPUT: The LLM did not return a valid decision within the enabled skill scope. No draft was changed. / 大模型未返回符合已启用技能范围的有效路由结果，原草稿未修改。');
  }

  async resolvePluginForType(skillId: string, skillIds?: string[]): Promise<AgentSkillPlugin | null> {
    return this.registry.resolvePluginForIdentifier(skillId, skillIds);
  }

  async buildModel(
    state: DraftState,
    skillIds?: string[],
    context?: { message?: string; locale?: AppLocale; currentModel?: Record<string, unknown>; conversationHistory?: string;
      sectionEvidence?: SectionEvidence; signal?: AbortSignal },
  ): Promise<Record<string, unknown> | undefined> {
    const policy = currentRunPolicy();
    const { currentDraftDiagnostics, unresolvedDraftFields, isDesignDraftField } = await import('./draft-diagnostics.js');
    state = currentDraftDiagnostics(state);
    if (policy) skillIds = policy.activeSkillIds.filter(id => skillIds === undefined || skillIds.includes(id));
    const plugin = await this.registry.resolvePluginForState(state, skillIds);
    assertResolvedInput(state.engineeringDraft?.inputEvidence);
    const { buildExplicitDraftModel } = await import('./explicit-model.js');
    // A complete imported model is immutable input. Partial topology is still a
    // modeling task: llm policy must be allowed to finish it using the source text.
    const explicit = (plugin?.id === 'generic' || policy?.builder === 'llm') && !state.engineeringDraft?.model ? undefined : buildExplicitDraftModel(state);
    if (explicit) {
      const unresolved = unresolvedDraftFields(state).filter(field => !isDesignDraftField(field));
      if (unresolved.length) throw new Error(`MODEL_DRAFT_INCOMPLETE: ${unresolved.join(', ')} / 尚有未解决的工程输入`);
      recordRunEvent({ kind: 'model_builder', builder: 'explicit', requestedBuilder: policy?.builder ?? 'auto',
        source: state.engineeringDraft?.model ? 'model' : 'topology' });
      if (plugin?.id === 'generic' || state.engineeringDraft?.loads?.some(load => load.selector)) {
        const { ModelPhysicsError } = await import('../engineering/model-physics.js');
        const { checkModelPhysicsWithAreaLoads } = await import('../engineering/model-area-loads.js');
        const physics = await checkModelPhysicsWithAreaLoads(explicit, state.engineeringDraft);
        if (!physics.valid) throw new ModelPhysicsError(physics);
      }
      return explicit;
    }
    if (!plugin) return undefined;

    const missing = computeDraftMissing(plugin, state, 'execution');
    if (missing.critical.length > 0) {
      throw new Error(`MODEL_DRAFT_INCOMPLETE: ${describeCriticalMissing(missing.critical, state).join(', ')}. Ask the user to clarify these unresolved fields; extract only a new answer, then rebuild / 请澄清这些尚未解决的字段；收到新答复后再提取并建模，不要重复提取同一消息。`);
    }

    // Deterministic model building (beam, truss, frame, etc.)
    const model = policy?.builder === 'llm' ? undefined : plugin.handler.buildModel(state);
    if (model) {
      if (state.engineeringDraft?.loads?.some(load => load.selector)) {
        const { ModelPhysicsError } = await import('../engineering/model-physics.js');
        const { checkModelPhysicsWithAreaLoads } = await import('../engineering/model-area-loads.js');
        const physics = await checkModelPhysicsWithAreaLoads(model, state.engineeringDraft);
        if (!physics.valid) throw new ModelPhysicsError(physics);
      }
      recordRunEvent({ kind: 'model_builder', builder: 'template', skillId: plugin.id });
      return model;
    }

    // The generic skill and an explicit LLM builder policy require the configured model builder.
    if ((plugin.id === 'generic' || policy?.builder === 'llm') && context) {
      recordRunEvent({ kind: 'model_builder', builder: 'llm', skillId: plugin.id });
      const { tryBuildGenericModelWithLlm } = await import('../agent-skills/structure-type/generic/llm-model-builder.js');
      const { createChatModel } = await import('../utils/llm.js');
      const { normalizeEngineeringModel } = await import('../engineering/model-boundary.js');
      const { createLocalStructureProtocolClient } = await import('../skill-shared/structure-protocol-execution.js');
      const protocol = createLocalStructureProtocolClient();
      context.signal?.throwIfAborted();
      const llm = createChatModel(0, { purpose: 'model-build' });
      if (!llm) {
        throw new Error(
          context.locale === 'zh'
            ? 'LLM_MODEL_BUILDER_REQUIRED: 尚未配置大模型，无法构建模型。请在设置中配置并启用模型提供商。'
            : 'LLM_MODEL_BUILDER_REQUIRED: Model building requires an LLM. Configure and enable a model provider in Settings.',
        );
      }
      return tryBuildGenericModelWithLlm(
        llm, context.message || '', state, context.locale || 'zh', policy?.context.history === 'current-turn' ? undefined : context.conversationHistory, context.signal, context.currentModel,
        candidate => normalizeEngineeringModel(candidate, protocol, undefined, context.sectionEvidence),
      );
    }

    return undefined;
  }

  async buildReportNarrative(
    input: SkillReportNarrativeInput,
    draft?: DraftState,
    skillIds?: string[],
  ): Promise<string> {
    const plugin = await this.registry.resolvePluginForState(draft, skillIds);
    if (plugin?.handler.buildReportNarrative) {
      return plugin.handler.buildReportNarrative(input);
    }
    return buildDefaultReportNarrative(input);
  }

}
