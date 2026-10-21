import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/lib/stores/context'
import { API_BASE } from '@/lib/api-base'
import { ALL_SKILL_DOMAINS, buildSkillNormalizationContext, defaultCapabilitySkillIds } from '@/lib/skill-normalization'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import type { ConversationRuntimeSnapshot } from '../use-conversation-runtime'
import type { AgentSkillSummary, CapabilityMatrixPayload } from './types'
import { normalizeToolCategory, resolveToolLabel } from './capabilities'
import type { RunPolicyInput } from '../run-settings'
import { CAPABILITY_PREFERENCE_STORAGE_KEY, loadCapabilityPreferences } from '@/lib/capability-preference'
import { SETTINGS_CHANGED_EVENT } from '@/components/settings/use-run-policy-settings'

/**
 * Loads the skill catalog and capability matrix, and derives the active
 * skill/tool selection from the capability preferences in the store.
 */
export function useCapabilityCatalog(locale: AppLocale, sessionView: ConversationRuntimeSnapshot | null, overrides: RunPolicyInput = {}) {
  const [availableSkills, setAvailableSkills] = useState<AgentSkillSummary[]>([])
  const [capabilityMatrix, setCapabilityMatrix] = useState<CapabilityMatrixPayload | null>(null)
  const [globalRunPolicy, setGlobalRunPolicy] = useState<RunPolicyInput>({})
  const storeSkillIds = useStore((s) => s.capabilitySkillIds)
  const storeToolIds = useStore((s) => s.capabilityToolIds)
  const storeExplicit = useStore((s) => s.capabilityExplicit)
  const setCapabilityPreferences = useStore((s) => s.setCapabilityPreferences)
  const [skillsLoaded, setSkillsLoaded] = useState(false)
  const [capabilityMatrixLoaded, setCapabilityMatrixLoaded] = useState(false)
  const [skillsFailed, setSkillsFailed] = useState(false)
  const [capabilityMatrixFailed, setCapabilityMatrixFailed] = useState(false)
  const [catalogRefresh, setCatalogRefresh] = useState(0)

  const skillNormalization = useMemo(
    () => buildSkillNormalizationContext(availableSkills, capabilityMatrix),
    [availableSkills, capabilityMatrix]
  )
  const skillDomainById = skillNormalization.skillDomainById

  const selectedSkillIds = useMemo(() => {
    const scope = overrides.skillIds === null ? availableSkills.map(skill => skill.id)
      : overrides.skillIds ?? sessionView?.policy?.activeSkillIds ?? (storeExplicit ? storeSkillIds : availableSkills.map(skill => skill.id))
    return skillNormalization.normalizeSkillIds(scope)
      .filter((skillId) => availableSkills.some((skill) => skill.id === skillId))
  }, [skillNormalization, storeSkillIds, availableSkills, overrides.skillIds, sessionView, storeExplicit])

  const defaultSelectedSkillIds = useMemo(() => {
    return defaultCapabilitySkillIds(availableSkills)
  }, [availableSkills])

  const availableTools = useMemo(() => {
    const allTools = Array.isArray(capabilityMatrix?.tools) ? capabilityMatrix.tools : []
    return [...allTools].sort((a, b) => {
      const left = resolveToolLabel(a, locale)
      const right = resolveToolLabel(b, locale)
      return left.localeCompare(right)
    })
  }, [capabilityMatrix, locale])

  const selectedToolIds = useMemo(() => {
    const allToolIds = new Set(availableTools.map((tool) => tool.id))
    return (sessionView?.policy?.activeToolIds ?? storeToolIds).filter((toolId) => allToolIds.has(toolId))
  }, [storeToolIds, availableTools, sessionView])

  const hasExplicitSkillSelection = overrides.skillIds !== undefined ? overrides.skillIds !== null : sessionView?.policy ? sessionView.policy.skillIds !== null : storeExplicit
  const hasExplicitToolSelection = Boolean(sessionView?.policy?.tools.enabledIds) || storeExplicit

  const loadedModules = useMemo(() => {
    return availableSkills
      .filter((skill) => selectedSkillIds.includes(skill.id))
      .map((skill) => ({
        id: skill.id,
        domain: skillDomainById[skill.id] || 'unknown',
        label: locale === 'zh' ? (skill.name.zh || skill.id) : (skill.name.en || skill.id),
        source: 'local' as const,
      }))
      .sort((a, b) => {
        const domainOrder = new Map(ALL_SKILL_DOMAINS.map((domain, index) => [domain, index]))
        const left = domainOrder.get(a.domain) ?? Number.MAX_SAFE_INTEGER
        const right = domainOrder.get(b.domain) ?? Number.MAX_SAFE_INTEGER
        if (left !== right) {
          return left - right
        }
        return a.label.localeCompare(b.label)
      })
  }, [availableSkills, locale, selectedSkillIds, skillDomainById])

  const loadedTools = useMemo(() => {
    return availableTools
      .filter((tool) => selectedToolIds.includes(tool.id))
      .map((tool) => ({
        id: tool.id,
        category: normalizeToolCategory(tool.category),
        label: resolveToolLabel(tool, locale),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [availableTools, locale, selectedToolIds])

  useEffect(() => {
    let active = true

    setSkillsLoaded(false)
    setSkillsFailed(false)
    async function loadSkills() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/agent/skills`)
        if (!response.ok) throw new Error('SKILL_CATALOG_UNAVAILABLE')
        const payload = await response.json()
        const skillsArray = Array.isArray(payload) ? payload : Array.isArray(payload?.skills) ? payload.skills : null
        if (!skillsArray) throw new Error('SKILL_CATALOG_INVALID')
        if (!active) return
        setAvailableSkills(skillsArray as AgentSkillSummary[])
        setSkillsLoaded(true)
      } catch {
        if (active) setSkillsFailed(true)
      }
    }

    void loadSkills()

    return () => {
      active = false
    }
  }, [catalogRefresh])

  // Load global defaults independently of the selected conversation. Old localStorage is read once.
  useEffect(() => {
    if (!skillsLoaded || !capabilityMatrixLoaded) return
    const controller = new AbortController()
    async function loadDefaults() {
      const response = await fetch(`${API_BASE}/api/v1/admin/settings`, { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) throw new Error('SETTINGS_UNAVAILABLE')
      const data = await response.json()
      let policy: RunPolicyInput = data.agent.runPolicy.value
      const legacy = loadCapabilityPreferences()
      if (legacy?.explicit && policy.skillIds === undefined) {
        policy = { ...policy, skillIds: legacy.skillIds.length || legacy.emptyScope ? legacy.skillIds : null,
          ...(legacy.preferredProviderIds?.length ? { providers: { ...policy.providers, preferredIds: legacy.preferredProviderIds } } : {}) }
        const migrated = await fetch(`${API_BASE}/api/v1/admin/settings`, { method: 'PUT', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: { runPolicy: policy } }) })
        if (!migrated.ok) throw new Error('SETTINGS_MIGRATION_FAILED')
      }
      if (controller.signal.aborted) return
      setGlobalRunPolicy(policy)
      window.localStorage.removeItem(CAPABILITY_PREFERENCE_STORAGE_KEY)
      const defaultToolIds = availableTools.filter(tool => tool.enabledByDefault).map(tool => tool.id)
      setCapabilityPreferences(policy.skillIds ?? defaultSelectedSkillIds, policy.tools?.enabledIds ?? defaultToolIds, policy.skillIds != null)
    }
    void loadDefaults().catch(() => { if (!controller.signal.aborted) setSkillsFailed(true) })
    return () => controller.abort()
  }, [availableTools, capabilityMatrixLoaded, defaultSelectedSkillIds, setCapabilityPreferences, skillsLoaded, catalogRefresh])

  useEffect(() => {
    const refresh = () => setCatalogRefresh(value => value + 1)
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh)
  }, [])

  useEffect(() => {
    let active = true

    setCapabilityMatrixLoaded(false)
    setCapabilityMatrixFailed(false)
    async function loadCapabilityMatrix() {
      try {
        const response = await fetch(`${API_BASE}/api/v1/agent/capability-matrix`)
        if (!response.ok) throw new Error('CAPABILITY_CATALOG_UNAVAILABLE')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tools)) throw new Error('CAPABILITY_CATALOG_INVALID')
        if (!active) return
        setCapabilityMatrix(payload as CapabilityMatrixPayload)
        setCapabilityMatrixLoaded(true)
      } catch {
        if (active) setCapabilityMatrixFailed(true)
      }
    }

    void loadCapabilityMatrix()

    return () => {
      active = false
    }
  }, [catalogRefresh])

  return {
    availableSkills,
    capabilityMatrix,
    globalRunPolicy,
    skillsLoaded,
    capabilityMatrixLoaded,
    skillsFailed,
    capabilityMatrixFailed,
    setCatalogRefresh,
    skillDomainById,
    selectedSkillIds,
    selectedToolIds,
    hasExplicitSkillSelection,
    hasExplicitToolSelection,
    loadedModules,
    loadedTools,
  }
}
