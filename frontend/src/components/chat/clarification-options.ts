// Old sessions and untyped stream payloads may contain { label, value } choices.
// Only display and submit readable strings; never render an arbitrary object.
export function normalizeClarificationOptions(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const options = input.flatMap(option => {
    const candidates = typeof option === 'string' ? [option]
      : option && typeof option === 'object' ? [option.label, option.text, option.value] : []
    const text = candidates.find(value => typeof value === 'string' && value.trim())
    return typeof text === 'string' ? [text.trim()] : []
  })
  return [...new Set(options)]
}
