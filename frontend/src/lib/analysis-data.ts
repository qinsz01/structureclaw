const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Resolve the explicit selected-result alias in chat projections without substituting another case. */
export function analysisData(analysis: Record<string, unknown>): Record<string, unknown> | null {
  if (analysis.selectedDataReference !== undefined) {
    const key = record(analysis.selectedDataReference) ? analysis.selectedDataReference.resultKey : undefined
    if (typeof key !== 'string' || key !== analysis.selectedResultKey || !record(analysis.results)) return null
    const result = analysis.results[key]
    return record(result) && record(result.data) ? result.data : null
  }
  return record(analysis.data) ? analysis.data : analysis
}
