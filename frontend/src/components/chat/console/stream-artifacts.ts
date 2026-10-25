import type { AgentResult, StreamPayload } from './types'
import type { TurnState } from './turn-state'

/** Per-turn storage also works for background streams; no active-conversation state is read. */
export function rememberStreamArtifact(turn: TurnState, payload: Extract<StreamPayload, { type: 'artifact_payload_sync' }>) {
  const kind = payload.artifact
  if (!kind) return
  if (payload.invalidated) {
    if (turn.streamArtifacts) {
      delete turn.streamArtifacts[kind]
      if (kind === 'analysis') delete turn.streamArtifacts.report
    }
    return
  }
  const value = kind === 'model' ? payload.model : payload.latestResult?.[kind]
  if (payload.artifactId && value && typeof value === 'object' && !Array.isArray(value)) {
    turn.streamArtifacts ??= {}
    turn.streamArtifacts[kind] = { id: payload.artifactId, value }
  }
}

export function resolveStreamArtifacts(turn: TurnState, incoming: AgentResult, missingMessage: string): AgentResult {
  const { artifactReferences, ...result } = incoming
  for (const kind of ['model', 'analysis', 'report'] as const) {
    const id = artifactReferences?.[kind]
    if (id === undefined) continue
    const saved = turn.streamArtifacts?.[kind]
    if (typeof id !== 'string' || !saved || saved.id !== id) throw new Error(missingMessage)
    result[kind] = saved.value
  }
  turn.streamArtifacts = undefined
  return result
}
