import { describe, expect, it } from 'vitest'
import { rememberStreamArtifact, resolveStreamArtifacts } from '@/components/chat/console/stream-artifacts'
import type { TurnState } from '@/components/chat/console/turn-state'

const turn = () => ({ streamArtifacts: undefined }) as Pick<TurnState, 'streamArtifacts'> as TurnState

describe('stream artifact references', () => {
  it('assembles all final data from the same turn even when it is a background conversation', () => {
    const state = turn(), model = { nodes: [] }, analysis = { runId: 'r', results: {} }, report = { markdown: 'Report' }
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'model', artifactId: 'm1', model })
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'analysis', artifactId: 'a1', latestResult: { analysis } })
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'report', artifactId: 'r1', latestResult: { report } })
    const result = resolveStreamArtifacts(state, { response: 'Done', artifactReferences: { model: 'm1', analysis: 'a1', report: 'r1' } }, 'missing')
    expect(result).toEqual({ response: 'Done', model, analysis, report })
    expect(result.analysis).toBe(analysis)
    expect(state.streamArtifacts).toBeUndefined()
  })
  it('fails explicitly for missing, invalidated, changed or cross-turn references', () => {
    const state = turn(), analysis = { runId: 'r' }
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'analysis', artifactId: 'old', latestResult: { analysis } })
    for (const other of [turn(), state]) expect(() => resolveStreamArtifacts(other, { artifactReferences: { analysis: 'missing' } }, 'missing')).toThrow('missing')
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true })
    expect(() => resolveStreamArtifacts(state, { artifactReferences: { analysis: 'old' } }, 'missing')).toThrow('missing')
  })
  it('analysis invalidation clears dependent reports; legacy complete results still work', () => {
    const state = turn()
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'report', artifactId: 'r', latestResult: { report: { markdown: 'old' } } })
    rememberStreamArtifact(state, { type: 'artifact_payload_sync', artifact: 'analysis', invalidated: true })
    expect(state.streamArtifacts?.report).toBeUndefined()
    expect(resolveStreamArtifacts(state, { response: 'Done', analysis: { runId: 'new' } }, 'missing')).toEqual({ response: 'Done', analysis: { runId: 'new' } })
  })
})
