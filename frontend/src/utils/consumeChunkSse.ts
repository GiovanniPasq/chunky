import type { ChunkSettings, Chunk } from '../types'
import { parseSse } from './parseSse'
import { API_BASE } from '../services/apiService'

function normaliseChunk(raw: Chunk): Chunk {
  return {
    index: raw.index,
    content: raw.content,
    cleaned_chunk: raw.cleaned_chunk ?? '',
    title: raw.title ?? '',
    context: raw.context ?? '',
    summary: raw.summary ?? '',
    keywords: raw.keywords ?? [],
    questions: raw.questions ?? [],
    metadata: raw.metadata ?? {},
    start: raw.start ?? 0,
    end: raw.end ?? 0,
  }
}

/**
 * POST /api/chunk for one or more filenames, consume SSE events.
 *
 * For a single filename returns the chunks from the file_done event.
 * Calls onFileStart / onFileDone for progress tracking in batch scenarios.
 */
export async function consumeChunkSse(
  filenames: string[],
  s: ChunkSettings,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
  onFileStart?: (filename: string, index: number, total: number) => void,
  onFileDone?: (filename: string, success: boolean, chunks: Chunk[]) => void,
): Promise<Chunk[]> {
  const res = await fetch(`${API_BASE}/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      filenames,
      chunker_type: s.chunkerType,
      chunker_library: s.chunkerLibrary,
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

  let firstFileChunks: Chunk[] = []

  for await (const event of parseSse(res.body, onConnectionLost)) {
    if (event.type === 'file_start') {
      onFileStart?.(event.filename as string, event.index as number, event.total as number)
    } else if (event.type === 'file_done') {
      const filename = event.filename as string
      const success = event.success as boolean
      const raw = (event.chunks ?? []) as Chunk[]
      const chunks = raw.map(normaliseChunk)
      onFileDone?.(filename, success, chunks)
      if (filename === filenames[0] && success) firstFileChunks = chunks
      if (!success && filenames.length === 1) {
        throw new Error(String(event.error ?? 'Chunking failed'))
      }
    } else if (event.type === 'batch_done') {
      break
    } else if (event.type === 'error') {
      throw new Error(String(event.message ?? 'Chunking error'))
    } else if (event.type === 'cancelled') {
      throw new DOMException('Chunking cancelled', 'AbortError')
    }
  }

  return firstFileChunks
}
