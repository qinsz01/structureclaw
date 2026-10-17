import { describe, expect, test } from '@jest/globals';
import { resolveRunPolicy, runPolicyInputSchema } from '../../../dist/runtime/run-policy.js';
import { ABLATION_PROFILES_VERSION, PROFILE_IDS, describeProfile, listProfiles, parseRunProfileEnv, profilePolicyInput,
  missingInputNextAction, runFeatures } from '../../../dist/runtime/ablation-profiles.js';

const tools = ['ask_user_clarification', 'build_model', 'memory', 'run_analysis', 'validate_model'];
const catalog = {
  availableSkillIds: ['beam', 'frame', 'generic', 'opensees-static', 'report-export-builtin'],
  structureTypeSkillIds: ['beam', 'frame', 'generic'],
  availableToolIds: tools, defaultToolIds: tools,
};
const resolve = (extra = {}) => resolveRunPolicy({ ...catalog, ...extra });

describe('ablation profiles', () => {
  test('version constant and the pre-registered profile table are present', () => {
    expect(ABLATION_PROFILES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(PROFILE_IDS).toEqual(['full', 'generic-only', 'no-routing', 'no-knowledge', 'no-template-builder', 'no-validation-gate',
      'no-clarification', 'no-state-versioning', 'no-evidence-binding', 'no-repair']);
    for (const profile of listProfiles()) {
      expect(profile.version).toBe(ABLATION_PROFILES_VERSION);
      expect(profile.removes.en.length).toBeGreaterThan(0);
      expect(profile.removes.zh.length).toBeGreaterThan(0);
      // Every profile specifies every mechanism field, so switching profiles never inherits an ablation.
      expect(Object.keys(profile.policy).sort()).toEqual(['builder', 'features', 'knowledge', 'repair', 'routing', 'skillIds']);
    }
  });

  test('full profile keeps the default policy hash and omits new fields from the default policy', () => {
    const base = resolve();
    expect(base).not.toHaveProperty('features');
    expect(base).not.toHaveProperty('profileId');
    expect(Object.keys(base.fieldSources).some(key => key.startsWith('features') || key === 'profileId')).toBe(false);
    for (const selection of [{ requested: { profile: 'full' } }, { envProfile: 'full' }, { defaults: { profile: 'full' } }]) {
      const full = resolve(selection);
      expect(full.policyHash).toBe(base.policyHash);
      expect(full.profileId).toBe('full');
      expect(full).not.toHaveProperty('features');
    }
  });

  test('each ablation profile changes the hash and only its own mechanism', () => {
    const base = resolve();
    const expectations = {
      'generic-only': policy => expect(policy.activeSkillIds).toEqual(['generic', 'opensees-static', 'report-export-builtin']),
      'no-routing': policy => expect(policy.routing).toEqual({ mode: 'fixed', skillId: 'generic' }),
      'no-knowledge': policy => expect(policy.knowledge).toBe('disabled'),
      'no-template-builder': policy => expect(policy.builder).toBe('llm'),
      'no-validation-gate': policy => { expect(policy.activeToolIds).not.toContain('validate_model'); expect(policy.deniedToolIds).toEqual(['validate_model']); },
      'no-clarification': policy => { expect(policy.activeToolIds).not.toContain('ask_user_clarification'); expect(policy.deniedToolIds).toEqual(['ask_user_clarification']); },
      'no-state-versioning': policy => expect(policy.features.stateVersioning).toBe('off'),
      'no-evidence-binding': policy => expect(policy.features.evidenceBinding).toBe('off'),
      'no-repair': policy => expect(policy.repair).toEqual({ enabled: false, maxRecoveriesPerTurn: 0 }),
    };
    const hashes = new Set([base.policyHash]);
    for (const [id, check] of Object.entries(expectations)) {
      const policy = resolve({ requested: { profile: id } });
      expect(policy.profileId).toBe(id);
      check(policy);
      expect(policy.budgets).toEqual(base.budgets);
      expect(policy.tools).toEqual(base.tools);
      hashes.add(policy.policyHash);
    }
    expect(hashes.size).toBe(PROFILE_IDS.length);
  });

  test('precedence: request > env > settings > default, request fields override profile fields, sources recorded', () => {
    const settingsOnly = resolve({ defaults: { profile: 'no-knowledge' } });
    expect(settingsOnly).toMatchObject({ profileId: 'no-knowledge', knowledge: 'disabled' });
    expect(settingsOnly.fieldSources).toMatchObject({ profileId: 'settings', knowledge: 'settings', builder: 'settings' });

    const env = resolve({ defaults: { profile: 'no-knowledge', builder: 'llm' }, envProfile: 'no-repair' });
    // The env profile fully specifies mechanism fields, so it also overrides settings fields.
    expect(env).toMatchObject({ profileId: 'no-repair', knowledge: 'enabled', builder: 'auto', repair: { enabled: false } });
    expect(env.fieldSources).toMatchObject({ profileId: 'env', knowledge: 'env', builder: 'env', 'repair.enabled': 'env',
      'repair.maxRecoveriesPerTurn': 'default' });

    const request = resolve({ defaults: { profile: 'no-knowledge' }, envProfile: 'no-repair', requested: { profile: 'no-template-builder' } });
    expect(request).toMatchObject({ profileId: 'no-template-builder', builder: 'llm', knowledge: 'enabled', repair: { enabled: true } });
    expect(request.fieldSources).toMatchObject({ profileId: 'request', builder: 'request', 'repair.enabled': 'request' });

    const override = resolve({ envProfile: 'no-clarification', requested: { features: { clarification: 'enabled' }, knowledge: 'disabled' } });
    expect(override).toMatchObject({ profileId: 'no-clarification', knowledge: 'disabled' });
    expect(override.activeToolIds).toContain('ask_user_clarification');
    expect(override).not.toHaveProperty('features');
    expect(override.fieldSources).toMatchObject({ profileId: 'env', 'features.clarification': 'request', 'features.validation': 'env', knowledge: 'request' });

    // A session policy outranks the env profile; a requested profile outranks the session.
    const previous = resolve({ requested: { profile: 'no-knowledge' } });
    const continued = resolve({ previous, envProfile: 'no-repair' });
    expect(continued).toMatchObject({ profileId: 'no-knowledge', knowledge: 'disabled', repair: { enabled: true } });
    expect(continued.fieldSources.profileId).toBe('session');
    const switched = resolve({ previous, requested: { profile: 'full' } });
    expect(switched).toMatchObject({ profileId: 'full', knowledge: 'enabled' });
    expect(switched.policyHash).toBe(resolve().policyHash);
  });

  test('explicit fields that depart from the profile preset are recorded as profileOverrides and hashed', () => {
    const base = resolve();
    const pure = resolve({ requested: { profile: 'no-knowledge' } });
    expect(pure).not.toHaveProperty('profileOverrides');
    // Turn 2 re-enables knowledge: the saved profile id stays, but the label is no longer a pure ablation.
    const reenabled = resolve({ previous: pure, requested: { knowledge: 'enabled' } });
    expect(reenabled).toMatchObject({ profileId: 'no-knowledge', knowledge: 'enabled', profileOverrides: ['knowledge'] });
    expect(reenabled.policyHash).not.toBe(base.policyHash);
    expect(reenabled.policyHash).not.toBe(pure.policyHash);
    // Overrides are recomputed each turn, not inherited from the saved policy.
    expect(resolve({ previous: reenabled, requested: { knowledge: 'disabled' } })).not.toHaveProperty('profileOverrides');
    expect(resolve({ envProfile: 'no-repair', requested: { knowledge: 'disabled', features: { validation: 'disabled' } } }).profileOverrides)
      .toEqual(['knowledge', 'features.validation']);
    // Skill lists only narrow scope and are not overrides; full with no overrides keeps the default hash.
    expect(resolve({ requested: { profile: 'no-knowledge' }, legacy: { skillIds: ['beam'] } })).not.toHaveProperty('profileOverrides');
    expect(resolve({ envProfile: 'generic-only', legacy: { skillIds: ['beam', 'generic'] } })).not.toHaveProperty('profileOverrides');
    expect(resolve({ requested: { profile: 'full', builder: 'auto' } }).policyHash).toBe(base.policyHash);
    expect(resolve({ requested: { profile: 'full', builder: 'llm' } }).profileOverrides).toEqual(['builder']);
    expect(resolve({ requested: { builder: 'llm' } })).not.toHaveProperty('profileOverrides');
  });

  test('generic-only is a skill ceiling: explicit or legacy skill lists cannot re-enable specialist structure skills', () => {
    const legacy = resolve({ envProfile: 'generic-only', legacy: { skillIds: ['beam', 'generic', 'opensees-static'] } });
    expect(legacy.activeSkillIds).toEqual(['generic', 'opensees-static']);
    expect(legacy.deniedSkillIds).toEqual(['beam']);
    expect(legacy.fieldSources).toMatchObject({ profileId: 'env', skillIds: 'legacy' });
    expect(() => resolveRunPolicy({ ...catalog, structureTypeSkillIds: undefined, requested: { profile: 'generic-only' } }))
      .toThrow('RUN_PROFILE_SKILL_DOMAINS_REQUIRED');
    expect(profilePolicyInput('generic-only', catalog).skillIds).toEqual(['generic', 'opensees-static', 'report-export-builtin']);
  });

  test('unknown profile ids fail fast with a bilingual error at request validation and startup', () => {
    const parsed = runPolicyInputSchema.safeParse({ profile: 'no-such-profile' });
    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toContain('UNKNOWN_RUN_PROFILE');
    expect(parsed.error.issues[0].message).toContain('未知的运行配置档');
    expect(() => parseRunProfileEnv('no-such-profile')).toThrow(/UNKNOWN_RUN_PROFILE.*未知的运行配置档/);
    expect(parseRunProfileEnv(undefined)).toBeUndefined();
    expect(parseRunProfileEnv('  ')).toBeUndefined();
    expect(parseRunProfileEnv(' no-repair ')).toBe('no-repair');
    expect(() => runPolicyInputSchema.parse({ features: { clarification: 'maybe' } })).toThrow();
  });

  test('helpers: feature defaults, missing-input next action and descriptions', () => {
    expect(runFeatures(undefined)).toEqual({ clarification: 'enabled', validation: 'enabled', stateVersioning: 'on', evidenceBinding: 'on' });
    expect(missingInputNextAction(true)).toBe('ask_user_clarification');
    expect(missingInputNextAction(false)).toBe('report_missing_inputs');
    expect(describeProfile('no-routing')).toMatchObject({ id: 'no-routing', skillScope: 'unchanged', targets: ['A'] });
    expect(describeProfile('generic-only').skillScope).toBe('generic-structure-only');
  });
});
