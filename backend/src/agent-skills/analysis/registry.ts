import { existsSync } from 'fs';
import path from 'path';
import { listProviders, type ProviderDefinition } from '../../providers/catalog.js';
import { resolveBackendAsset } from '../../utils/bundled-paths.js';
import type {
  AnalysisEngineDefinition,
  AnalysisExecutionAction,
  AnalysisModelFamily,
  AnalysisSkillManifest,
  BuiltInAnalysisEngineId,
} from './types.js';

const ANALYSIS_TYPE_ORDER = ['static', 'dynamic', 'seismic', 'nonlinear'] as const;
const MODEL_FAMILY_ORDER = ['frame', 'truss', 'generic'] as const;

function toAnalysisSkillManifest(provider: ProviderDefinition): AnalysisSkillManifest {
  if (!provider.runtimePath || !existsSync(resolveBackendAsset('src/' + provider.runtimePath))) {
    throw new Error('Missing solver runtime: ' + provider.id);
  }
  if (!provider.software || !provider.analysisType || !provider.engineId || !provider.adapterKey) {
    throw new Error('Incomplete solver provider metadata: ' + provider.id);
  }
  return {
    id: provider.id, domain: 'analysis', name: provider.name, description: provider.description,
    software: provider.software as AnalysisSkillManifest['software'], analysisType: provider.analysisType,
    engineId: provider.engineId as BuiltInAnalysisEngineId,
    adapterKey: provider.adapterKey as AnalysisSkillManifest['adapterKey'],
    triggers: [], stages: ['analysis'], capabilities: ['analysis-policy', 'analysis-execution'],
    supportedModelFamilies: provider.supportedModelFamilies as AnalysisModelFamily[],
    priority: provider.priority, runtimeRelativePath: path.basename(provider.runtimePath),
  };
}

function discoverBuiltinAnalysisSkills(): AnalysisSkillManifest[] {
  return listProviders('solver').map(toAnalysisSkillManifest)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

function uniqueOrdered<T extends string>(values: readonly T[], order: readonly T[]): T[] {
  const seen = new Set(values);
  return order.filter((value) => seen.has(value));
}

function buildEngineDefinition(
  skills: readonly AnalysisSkillManifest[],
  options: {
    id: BuiltInAnalysisEngineId;
    name: string;
    priority: number;
    routingHints: string[];
    constraints: Record<string, unknown>;
  },
): AnalysisEngineDefinition {
  const engineSkills = skills.filter((skill) => skill.engineId === options.id);
  if (engineSkills.length === 0) {
    throw new Error(`No builtin analysis skills registered for engine '${options.id}'`);
  }

  const adapterKey = engineSkills[0].adapterKey;
  return {
    id: options.id,
    name: options.name,
    adapterKey,
    capabilities: ['analyze', 'validate', 'code-check'],
    supportedAnalysisTypes: uniqueOrdered(
      engineSkills.map((skill) => skill.analysisType),
      ANALYSIS_TYPE_ORDER,
    ),
    supportedModelFamilies: uniqueOrdered(
      engineSkills.flatMap((skill) => skill.supportedModelFamilies),
      MODEL_FAMILY_ORDER as readonly AnalysisModelFamily[],
    ),
    priority: options.priority,
    routingHints: options.routingHints,
    constraints: options.constraints,
    skillIds: engineSkills.map((skill) => skill.id),
  };
}

const BUILTIN_ANALYSIS_SKILLS: AnalysisSkillManifest[] = discoverBuiltinAnalysisSkills();

/** Builtin analysis skill manifests (priority descending, then id). */
export function listBuiltinAnalysisSkills(): readonly AnalysisSkillManifest[] {
  return BUILTIN_ANALYSIS_SKILLS;
}

export const BUILTIN_ANALYSIS_ENGINES: AnalysisEngineDefinition[] = [
  buildEngineDefinition(BUILTIN_ANALYSIS_SKILLS, {
    id: 'builtin-opensees',
    name: 'OpenSees Builtin',
    priority: 100,
    routingHints: ['high-fidelity', 'default'],
    constraints: { requiresOpenSees: true },
  }),
  buildEngineDefinition(BUILTIN_ANALYSIS_SKILLS, {
    id: 'builtin-pkpm',
    name: 'PKPM Builtin',
    priority: 90,
    routingHints: ['commercial', 'design-code'],
    constraints: { requiresPKPM: true },
  }),
  buildEngineDefinition(BUILTIN_ANALYSIS_SKILLS, {
    id: 'builtin-yjk',
    name: 'YJK Builtin',
    priority: 85,
    routingHints: ['commercial', 'design-code'],
    constraints: { requiresYJK: true },
  }),
];

export const BUILTIN_ANALYSIS_RUNTIME_ADAPTER_KEYS = BUILTIN_ANALYSIS_ENGINES.map((engine) => engine.adapterKey);

export const LOCAL_GET_ACTION_BY_PATH: Record<string, AnalysisExecutionAction> = {
  '/engines': 'list_engines',
};

export const LOCAL_POST_ACTION_BY_PATH: Record<string, AnalysisExecutionAction> = {
  '/analyze': 'analyze',
};
