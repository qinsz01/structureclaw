import type { RefObject } from 'react'
import type { AppLocale } from '@/lib/stores/slices/preferences'
import { DEFAULT_CONSOLE_SKILL_IDS, type buildSkillNormalizationContext } from '@/lib/skill-normalization'
import type { RunPolicyInput } from '../run-settings'
import type { ConversationRuntimeSnapshot } from '../use-conversation-runtime'
import type { UploadedFileAttachment } from './types'

/**
 * Builds the `context` sent with a chat turn: run policy, capability scope
 * (or keep the conversation's saved scope), model edit and attachments.
 */
export function buildTurnContextPayload(params: {
  skillNormalization: ReturnType<typeof buildSkillNormalizationContext>
  selectedSkillIds: string[]
  defaultSelectedSkillIds: string[]
  hasExplicitSkillSelection: boolean
  selectedToolIds: string[]
  hasExplicitToolSelection: boolean
  restoredScopeRef: RefObject<{ conversationId: string; skills: string[]; tools: string[] } | null>
  turnRuntime: ConversationRuntimeSnapshot | null
  nextConversationId: string
  storeSkillIds: string[]
  storeToolIds: string[]
  runPolicy: RunPolicyInput
  locale: AppLocale
  requestedContextModel: Record<string, unknown> | undefined
  requestedModelRevision: number | null
  hasSelectedCodeCheckSkill: boolean
  resumeFromMessage: string | undefined
  attachedFiles: UploadedFileAttachment[]
}) {
  const {
    skillNormalization,
    selectedSkillIds,
    defaultSelectedSkillIds,
    hasExplicitSkillSelection,
    selectedToolIds,
    hasExplicitToolSelection,
    restoredScopeRef,
    turnRuntime,
    nextConversationId,
    storeSkillIds,
    storeToolIds,
    runPolicy,
    locale,
    requestedContextModel,
    requestedModelRevision,
    hasSelectedCodeCheckSkill,
    resumeFromMessage,
    attachedFiles,
  } = params
  const normalizedSkillIds = skillNormalization.normalizeSkillIds(selectedSkillIds)
  const fallbackDefaultSkillIds = skillNormalization.normalizeSkillIds(
    defaultSelectedSkillIds.length > 0
      ? defaultSelectedSkillIds
      : [...DEFAULT_CONSOLE_SKILL_IDS]
  )
  const effectiveSkillIds = normalizedSkillIds.length > 0
    ? normalizedSkillIds
    : hasExplicitSkillSelection
      ? []
      : fallbackDefaultSkillIds
  const baseEnabledToolIds = selectedToolIds.length > 0
    ? selectedToolIds
    : hasExplicitToolSelection
      ? []
      : undefined
  const restoredScope = restoredScopeRef.current
  const sameIds = (left: string[], right: string[]) => [...left].sort().join('\0') === [...right].sort().join('\0')
  const keepSavedScope = Boolean(turnRuntime?.policy && (!restoredScope || restoredScope.conversationId !== nextConversationId
    || (sameIds(restoredScope.skills, storeSkillIds) && sameIds(restoredScope.tools, storeToolIds))))
  const contextPayload = {
    runPolicy: Object.keys(runPolicy).length ? runPolicy : undefined,
    locale,
    skillIds: keepSavedScope ? undefined : effectiveSkillIds,
    enabledToolIds: keepSavedScope ? undefined : baseEnabledToolIds,
    model: requestedContextModel,
    modelRevision: requestedContextModel ? requestedModelRevision ?? undefined : undefined,
    modelFormat: requestedContextModel ? 'structuremodel-v2' : undefined,
    engineId: undefined,
    autoCodeCheck: hasSelectedCodeCheckSkill || undefined,
    resumeFromMessage,
    attachments: attachedFiles.length > 0
      ? attachedFiles.map((f) => ({ fileId: f.fileId, originalName: f.originalName, relPath: f.relPath, mimeType: f.mimeType }))
      : undefined,
  }
  return contextPayload
}
