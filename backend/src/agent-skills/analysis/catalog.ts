import type { AgentAnalysisType } from '../../shared/types/agent.js';
import { listBuiltinAnalysisSkills } from './registry.js';
import type { BuiltInAnalysisEngineId } from './types.js';

/**
 * Single source for builtin analysis skill ids, their engine ids and analysis types.
 * Ids, engines and types come from the analysis skill manifests (skill.yaml) via the
 * registry loader; only the English display labels live here. The labels appear in tool
 * output text, so they must stay byte-stable. Key order defines the catalog order (and
 * therefore the order of the run_analysis `analysisSkillId` enum).
 */
export const ANALYSIS_SKILL_LABELS: Readonly<Record<string, string>> = {
  'opensees-static': 'OpenSees static analysis',
  'opensees-dynamic': 'OpenSees dynamic analysis',
  'opensees-seismic': 'OpenSees seismic analysis',
  'opensees-nonlinear': 'OpenSees nonlinear analysis',
  'pkpm-static': 'PKPM/SATWE static analysis',
  'yjk-static': 'YJK static analysis',
};

interface AnalysisSkillCatalogEntry {
  id: string;
  engineId: BuiltInAnalysisEngineId;
  analysisType: AgentAnalysisType;
}

const LABEL_ORDER = Object.keys(ANALYSIS_SKILL_LABELS);

function catalogRank(id: string): number {
  const index = LABEL_ORDER.indexOf(id);
  return index === -1 ? LABEL_ORDER.length : index;
}

export const ANALYSIS_SKILL_CATALOG: readonly AnalysisSkillCatalogEntry[] = listBuiltinAnalysisSkills()
  .map(({ id, engineId, analysisType }) => ({ id, engineId, analysisType }))
  .sort((left, right) => catalogRank(left.id) - catalogRank(right.id) || left.id.localeCompare(right.id));

const CATALOG_BY_ID = new Map(ANALYSIS_SKILL_CATALOG.map((entry) => [entry.id, entry]));

/** Analysis skill ids in catalog order, typed for `z.enum`. */
export const ANALYSIS_SKILL_IDS = ANALYSIS_SKILL_CATALOG.map((entry) => entry.id) as unknown as readonly [string, ...string[]];

/** Distinct builtin analysis engine ids in catalog order. */
export const ANALYSIS_ENGINE_IDS: readonly BuiltInAnalysisEngineId[] = [...new Set(ANALYSIS_SKILL_CATALOG.map((entry) => entry.engineId))];

export function getAnalysisSkillCatalogEntry(skillId: string | undefined): AnalysisSkillCatalogEntry | undefined {
  return typeof skillId === 'string' ? CATALOG_BY_ID.get(skillId) : undefined;
}

export function analysisSkillLabel(skillId: string): string {
  return ANALYSIS_SKILL_LABELS[skillId] ?? skillId;
}

interface AnalysisSkillContext {
  analysisType?: string;
  /** Already trimmed engine id. */
  engineId?: string;
  /** Already trimmed, lower-cased model families; empty means "any". */
  supportedModelFamilies?: readonly string[];
}

/** Whether an analysis skill satisfies the requested analysis type, engine and model families. */
export function matchesAnalysisContext(
  skill: { analysisType?: unknown; engineId?: unknown; supportedModelFamilies?: unknown },
  context: AnalysisSkillContext,
): boolean {
  if (context.analysisType && skill.analysisType !== context.analysisType) {
    return false;
  }
  if (context.engineId && skill.engineId !== context.engineId) {
    return false;
  }
  const requestedFamilies = context.supportedModelFamilies ?? [];
  if (requestedFamilies.length > 0) {
    const skillFamilies = Array.isArray(skill.supportedModelFamilies)
      ? skill.supportedModelFamilies.map((family: string) => family.trim().toLowerCase())
      : [];
    if (!skillFamilies.some((family) => requestedFamilies.includes(family))) {
      return false;
    }
  }
  return true;
}
