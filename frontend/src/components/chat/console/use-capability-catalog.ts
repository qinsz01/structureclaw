import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/lib/stores/context'
import { API_BASE } from '@/lib/api-base'
import { ALL_SKILL_DOMAINS, buildSkillNormalizationContext, DEFAULT_CONSOLE_SKILL_IDS } from '@/lib/skill-normalization'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import type { ConversationRuntimeSnapshot } from '../use-conversation-runtime'
import type { AgentSkillSummary, CapabilityMatrixPayload } from './types'
import { normalizeToolCategory, resolveToolLabel } from './capabilities'

/**
 * Loads the skill catalog and capability matrix, and derives the active
 * skill/tool selection from the capability preferences in the store.
 */
export function useCapabilityCatalog(locale: AppLocale, sessionView: ConversationRuntimeSnapshot | null) {
  const [availableSkills, setAvailableSkills] = useState<AgentSkillSummary[]>([])
  const [capabilityMatrix, setCapabilityMatrix] = useState<CapabilityMatrixPayload | null>(null)
  const storeSkillIds = useStore((s) => s.capabilitySkillIds)
  const storeToolIds = useStore((s) => s.capabilityToolIds)
  const storeExplicit = useStore((s) => s.capabilityExplicit)
  const setCapabilityPreferences = useStore((s) => s.setCapabilityPreferences)
  const restoredScopeRef = useRef<{ conversationId: string; skills: string[]; tools: string[] } | null>(null)
  const capabilityInitializedRef = useRef(false)
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
    return skillNormalization.normalizeSkillIds(storeSkillIds)
      .filter((skillId) => availableSkills.some((skill) => skill.id === skillId))
  }, [skillNormalization, storeSkillIds, availableSkills])

  const defaultSelectedSkillIds = useMemo(() => {
    const available = new Set(availableSkills.map((skill) => skill.id))
    return DEFAULT_CONSOLE_SKILL_IDS.filter((skillId) => available.has(skillId))
  }, [availableSkills])

  const hasSelectedCodeCheckSkill = useMemo(
    () => selectedSkillIds.some((skillId) => skillDomainById[skillId] === 'code-check'),
    [selectedSkillIds, skillDomainById]
  )

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
    return storeToolIds.filter((toolId) => allToolIds.has(toolId))
  }, [storeToolIds, availableTools])

  const hasExplicitSkillSelection = storeExplicit
  const hasExplicitToolSelection = storeExplicit

  useEffect(() => {
    const saved = sessionView
    if (!saved?.policy || restoredScopeRef.current?.conversationId === saved.conversationId) return
    const { activeSkillIds: skills, activeToolIds: tools } = saved.policy
    setCapabilityPreferences(skills, tools, true)
    restoredScopeRef.current = { conversationId: saved.conversationId, skills, tools }
  }, [sessionView, setCapabilityPreferences])

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

  // One-time initialization: apply defaults if store is empty
  useEffect(() => {
    if (capabilityInitializedRef.current) return
    if (!skillsLoaded || !capabilityMatrixLoaded) return
    capabilityInitializedRef.current = true

    if (!storeExplicit) {
      const defaultToolIds = availableTools.filter((tool) => tool.enabledByDefault).map((tool) => tool.id)
      setCapabilityPreferences(defaultSelectedSkillIds, defaultToolIds, false)
    }
  }, [availableTools, capabilityMatrixLoaded, defaultSelectedSkillIds, setCapabilityPreferences, skillsLoaded, storeExplicit, storeSkillIds, storeToolIds])

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
    storeSkillIds,
    storeToolIds,
    setCapabilityPreferences,
    restoredScopeRef,
    skillsLoaded,
    capabilityMatrixLoaded,
    skillsFailed,
    capabilityMatrixFailed,
    setCatalogRefresh,
    skillNormalization,
    skillDomainById,
    selectedSkillIds,
    defaultSelectedSkillIds,
    hasSelectedCodeCheckSkill,
    selectedToolIds,
    hasExplicitSkillSelection,
    hasExplicitToolSelection,
    loadedModules,
    loadedTools,
  }
}
