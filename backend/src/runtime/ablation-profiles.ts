/**
 * Pre-registered, versioned ablation profiles (docs/ablation.md).
 *
 * A profile is a named RunPolicyInput preset that switches off exactly one mechanism while the
 * solver, budgets, tool interfaces and inputs stay identical. Every profile fully specifies the
 * mechanism fields (knowledge, builder, routing, skill scope, repair, features), so selecting a
 * profile mid-session cannot inherit another profile's ablation. Changing any entry requires a
 * new ABLATION_PROFILES_VERSION.
 */
import type { RunPolicyInput } from './run-policy-schema.js';

export const ABLATION_PROFILES_VERSION = '2026-10-21.12';

export const PROFILE_IDS = [
  'full', 'generic-only', 'no-routing', 'no-knowledge', 'no-template-builder', 'no-validation-gate',
  'no-clarification', 'no-state-versioning', 'no-evidence-binding', 'no-repair',
] as const;
export type ProfileId = typeof PROFILE_IDS[number];

export interface RunFeatures {
  clarification: 'enabled' | 'disabled';
  validation: 'enabled' | 'disabled';
  stateVersioning: 'on' | 'off';
  evidenceBinding: 'on' | 'off';
}
export const DEFAULT_RUN_FEATURES: Readonly<RunFeatures> = Object.freeze({
  clarification: 'enabled', validation: 'enabled', stateVersioning: 'on', evidenceBinding: 'on',
});

/** Bench review capability groups (2026-10-12): A model fidelity, B result interpretation,
 * C capability boundary / missing input, D state revision, E evidence and report provenance,
 * F constrained candidate selection. */
type CapabilityGroup = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

interface Localized { en: string; zh: string }
interface ProfileDefinition {
  /** Mechanism fields. `skillIds` is resolved from manifests when `genericStructureOnly` is set. */
  policy: RunPolicyInput;
  /** Restrict structure-type skills to `generic`; analysis and other domains stay. */
  genericStructureOnly?: boolean;
  removes: Localized;
  targets: CapabilityGroup[];
}

const FULL_MECHANISMS: RunPolicyInput = {
  knowledge: 'enabled', builder: 'auto', skillIds: null, routing: { mode: 'auto' }, repair: { enabled: true },
  features: { ...DEFAULT_RUN_FEATURES },
};
const preset = (patch: RunPolicyInput): RunPolicyInput => ({ ...FULL_MECHANISMS, ...patch,
  repair: { ...FULL_MECHANISMS.repair, ...patch.repair }, features: { ...DEFAULT_RUN_FEATURES, ...patch.features } });

const PROFILES: Record<ProfileId, ProfileDefinition> = {
  full: { policy: preset({}), targets: [],
    removes: { en: 'Nothing (reference configuration).', zh: '不移除任何机制（参照配置）。' } },
  'generic-only': { policy: preset({}), genericStructureOnly: true, targets: ['A', 'B'],
    removes: { en: 'Specialist structure-type skills; only the generic structure skill stays (analysis, code-check, report and other domains unchanged).',
      zh: '专用结构类型技能；结构类型仅保留 generic（分析、校核、报告等其他领域技能不变）。' } },
  'no-routing': { policy: preset({ routing: { mode: 'fixed', skillId: 'generic' } }), targets: ['A'],
    removes: { en: 'Automatic structure-skill selection; routing is fixed to the generic skill.',
      zh: '自动结构技能选择；路由固定为 generic 技能。' } },
  'no-knowledge': { policy: preset({ knowledge: 'disabled' }), targets: ['A', 'C'],
    removes: { en: 'Skill descriptions, triggers, stage names and stage markdown in every prompt (agent, structural router, parameter extractor).',
      zh: '所有提示词中的技能描述、触发词、阶段名称和阶段知识文本（主代理、结构路由、参数抽取）。' } },
  'no-template-builder': { policy: preset({ builder: 'llm' }), targets: ['A'],
    removes: { en: 'Deterministic template model builders; build_model asks the LLM model builder.',
      zh: '确定性模板建模器；build_model 改由大模型建模器生成模型。' } },
  'no-validation-gate': { policy: preset({ features: { validation: 'disabled' } }), targets: ['A', 'C'],
    removes: { en: 'The validate_model tool and its workflow step; model normalization and solver-side checks stay.',
      zh: 'validate_model 工具及其工作流步骤；模型规范化和求解器自身检查保留。' } },
  'no-clarification': { policy: preset({ features: { clarification: 'disabled' } }), targets: ['C'],
    removes: { en: 'The clarification interrupt tool and its prompt instructions; the agent lists missing inputs in its final reply instead.',
      zh: '澄清中断工具及相关提示；代理改为在最终回复中列出缺失输入。' } },
  'no-state-versioning': { policy: preset({ features: { stateVersioning: 'off' } }), targets: ['D', 'F'],
    removes: { en: 'Stale-result invalidation after model, draft or settings edits (hashes and revisions are still recorded).',
      zh: '模型、草稿或设置修改后的过期结果失效机制（仍记录哈希与版本号）。' } },
  'no-evidence-binding': { policy: preset({ features: { evidenceBinding: 'off' } }), targets: ['E', 'D'],
    removes: { en: 'Report provenance checks binding the report to the analysed model, run and code-check.',
      zh: '报告与分析模型、运行及校核结果之间的来源绑定检查。' } },
  'no-repair': { policy: preset({ repair: { enabled: false } }), targets: ['C', 'D'],
    removes: { en: 'Automatic rule fallbacks and recoveries, plus the recovery-encouraging prompt text.',
      zh: '自动规则回退与纠错重试，以及鼓励自动恢复的提示文本。' } },
};

function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value);
}

export function unknownProfileMessage(value: unknown): string {
  return `UNKNOWN_RUN_PROFILE: ${JSON.stringify(value)}; expected one of ${PROFILE_IDS.join(', ')} / 未知的运行配置档 ${JSON.stringify(value)}，可选值：${PROFILE_IDS.join('、')}`;
}

/** Parse SCLAW_RUN_PROFILE (empty = none); unknown ids fail fast at startup. */
export function parseRunProfileEnv(value: string | undefined): ProfileId | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!isProfileId(trimmed)) throw new Error(unknownProfileMessage(trimmed));
  return trimmed;
}

/**
 * Mechanism fields of a profile as a RunPolicyInput. `generic-only` needs the skill catalog:
 * every available skill except structure-type skills other than `generic`.
 */
export function profilePolicyInput(id: ProfileId, catalog: { availableSkillIds: string[]; structureTypeSkillIds?: string[] }): RunPolicyInput {
  const definition = PROFILES[id];
  const policy = structuredClone(definition.policy);
  if (!definition.genericStructureOnly) return policy;
  if (!catalog.structureTypeSkillIds) throw new Error('RUN_PROFILE_SKILL_DOMAINS_REQUIRED: generic-only needs structure-type skill ids');
  return { ...policy, skillIds: genericOnlySkillIds(catalog.availableSkillIds, catalog.structureTypeSkillIds) };
}

export function genericOnlySkillIds(availableSkillIds: string[], structureTypeSkillIds: string[]): string[] {
  const specialist = new Set(structureTypeSkillIds.filter(id => id !== 'generic'));
  return [...new Set(availableSkillIds.filter(id => !specialist.has(id)))].sort();
}

/** Whether the profile restricts the skill ceiling (explicit skillIds are intersected with it). */
export function profileRestrictsStructureSkills(id: ProfileId | undefined): boolean {
  return Boolean(id && PROFILES[id].genericStructureOnly);
}

interface ProfileDescription {
  id: ProfileId;
  version: string;
  policy: RunPolicyInput;
  skillScope: 'unchanged' | 'generic-structure-only';
  removes: Localized;
  targets: CapabilityGroup[];
}

export function describeProfile(id: ProfileId): ProfileDescription {
  const definition = PROFILES[id];
  return { id, version: ABLATION_PROFILES_VERSION, policy: structuredClone(definition.policy),
    skillScope: definition.genericStructureOnly ? 'generic-structure-only' : 'unchanged',
    removes: { ...definition.removes }, targets: [...definition.targets] };
}

export function listProfiles(): ProfileDescription[] {
  return PROFILE_IDS.map(describeProfile);
}

/** Feature flags with defaults filled in; a policy without `features` is the full system. */
export function runFeatures(policy: { features?: Partial<RunFeatures> } | null | undefined): RunFeatures {
  return { ...DEFAULT_RUN_FEATURES, ...policy?.features };
}

/** Next action for missing engineering input: the clarification tool only when it is offered. */
export type MissingInputNextAction = 'ask_user_clarification' | 'report_missing_inputs';
export function missingInputNextAction(clarificationEnabled: boolean): MissingInputNextAction {
  return clarificationEnabled ? 'ask_user_clarification' : 'report_missing_inputs';
}
