import type { StreamPayload } from './types'

/**
 * Reads a server-sent-event body, parsing each `data:` frame as a StreamPayload
 * and handing it to `onPayload`. Stops early once `signal` is aborted.
 */
export async function readStreamPayloads(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  onPayload: (payload: StreamPayload) => void,
) {
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    if (signal.aborted) break
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''

    for (const part of parts) {
      if (signal.aborted) break
      const line = part
        .split('\n')
        .map((item) => item.trim())
        .find((item) => item.startsWith('data:'))

      if (!line) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue

      let payload: StreamPayload
      try {
        payload = JSON.parse(raw) as StreamPayload
      } catch {
        continue
      }

      onPayload(payload)
    }
  }
}
