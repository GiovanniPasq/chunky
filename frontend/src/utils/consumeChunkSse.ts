import type { ChunkSettings, Chunk } from '../types'
import { parseSse } from './parseSse'
import { API_BASE } from '../services/apiService'

export async function consumeChunkSse(
  content: string,
  s: ChunkSettings,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
): Promise<Chunk[]> {
  const res = await fetch(`${API_BASE}/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      content,
      splitter_type: s.splitterType,
      splitter_library: s.splitterLibrary,
      chunk_size: s.chunkSize,
      chunk_overlap: s.chunkOverlap,
      enable_markdown_sizing: s.enableMarkdownSizing,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  if (!res.body) throw new Error('No response body')

  for await (const event of parseSse(res.body, onConnectionLost)) {
    if (event.type === 'done') {
      const raw = (event.chunks as Chunk[]) ?? []
      return raw.map(c => ({
        index: c.index,
        content: c.content,
        cleaned_chunk: c.cleaned_chunk ?? '',
        title: c.title ?? '',
        context: c.context ?? '',
        summary: c.summary ?? '',
        keywords: c.keywords ?? [],
        questions: c.questions ?? [],
        metadata: c.metadata ?? {},
        start: c.start ?? 0,
        end: c.end ?? 0,
      }))
    } else if (event.type === 'error') {
      throw new Error(String(event.message ?? 'Chunking error'))
    } else if (event.type === 'cancelled') {
      throw new DOMException('Chunking cancelled', 'AbortError')
    }
  }
  throw new Error('Stream ended without a done event')
}
