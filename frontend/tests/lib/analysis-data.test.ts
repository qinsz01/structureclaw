import { describe, expect, it } from 'vitest'
import { analysisData } from '@/lib/analysis-data'
import { buildSummaryStatsContext } from '@/components/chat/console/summary-stats/context'
import { extractSeismicContext } from '@/components/chat/console/seismic-context'

describe('selected chat analysis data', () => {
  const data = { summary: { maxDisplacement: .002 }, designBasis: { codeBasis: [] }, methodDecision: { method: 'response-spectrum' } }
  const run = { selectedResultKey: 'case:D', selectedDataReference: { resultKey: 'case:D' }, results: { 'case:D': { success: true, data } } }
  it('restores summary and seismic context from the explicit selected result', () => {
    expect(analysisData(run)).toBe(data)
    expect(buildSummaryStatsContext(run, key => key).summary).toEqual(data.summary)
    expect(extractSeismicContext({ analysis: run }, key => key, 'en')).not.toBeNull()
  })
  it('does not replace missing or mismatched selections with another result or stale alias', () => {
    expect(analysisData({ ...run, selectedResultKey: 'case:L', data: { stale: true } })).toBeNull()
    expect(analysisData({ ...run, results: {}, data: { stale: true } })).toBeNull()
    expect(analysisData({ ...run, selectedDataReference: {} })).toBeNull()
  })
  it('keeps both legacy wrapped and direct data compatible', () => {
    expect(analysisData({ data })).toBe(data)
    expect(analysisData(data)).toBe(data)
  })
})
