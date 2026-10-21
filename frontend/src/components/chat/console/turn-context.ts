import type { AppLocale } from '@/lib/stores/slices/preferences'
import type { RunPolicyInput } from '../run-settings'
import type { UploadedFileAttachment } from './types'

/**
 * Builds the `context` sent with a chat turn: run policy, capability scope
 * (or keep the conversation's saved scope), model edit and attachments.
 */
export function buildTurnContextPayload(params: {
  runPolicy: RunPolicyInput
  locale: AppLocale
  requestedContextModel: Record<string, unknown> | undefined
  requestedModelRevision: number | null
  resumeFromMessage: string | undefined
  attachedFiles: UploadedFileAttachment[]
}) {
  const { runPolicy, locale, requestedContextModel, requestedModelRevision, resumeFromMessage, attachedFiles } = params
  const contextPayload = {
    runPolicy: Object.keys(runPolicy).length ? runPolicy : undefined,
    locale,
    model: requestedContextModel,
    modelRevision: requestedContextModel ? requestedModelRevision ?? undefined : undefined,
    modelFormat: requestedContextModel ? 'structuremodel-v2' : undefined,
    resumeFromMessage,
    attachments: attachedFiles.length > 0
      ? attachedFiles.map(f => ({ fileId: f.fileId, originalName: f.originalName, relPath: f.relPath, mimeType: f.mimeType }))
      : undefined,
  }
  return contextPayload
}
