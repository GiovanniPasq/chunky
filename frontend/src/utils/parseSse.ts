/**
 * Shared SSE stream parser used by useDocument and MarkdownViewer.
 *
 * Yields parsed JSON events from an SSE ReadableStream.
 * Handles chunked delivery and multi-frame buffers correctly.
 * The underlying reader is always cancelled on return/throw.
 *
 * @param onSilent  Called when no bytes have been received for `silentMs`
 *                  milliseconds. Use this to show a "connection lost" warning.
 *                  The callback fires at most once per invocation.
 */

export const SSE_SILENT_MS = 60_000

/** Shared message shown when the SSE stream goes silent for too long. */
export const CONNECTION_LOST_MSG =
  'Connection lost — the operation may have been interrupted. You can safely start a new conversion.'

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onSilent?: () => void,
  silentMs = SSE_SILENT_MS,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let silentTimer: ReturnType<typeof setTimeout> | null = null
  let silentFired = false

  const armTimer = () => {
    if (!onSilent || silentFired) return
    if (silentTimer !== null) clearTimeout(silentTimer)
    silentTimer = setTimeout(() => {
      silentFired = true
      onSilent()
    }, silentMs)
  }

  try {
    armTimer()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      armTimer() // reset on every chunk received (data frames and keepalives alike)
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue
        try {
          yield JSON.parse(part.slice(6)) as Record<string, unknown>
        } catch {
          // Skip malformed frames
        }
      }
    }
  } finally {
    if (silentTimer !== null) clearTimeout(silentTimer)
    reader.cancel()
  }
}
