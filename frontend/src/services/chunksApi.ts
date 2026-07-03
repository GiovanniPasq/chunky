import type { Chunk, ChunksVersion, ChunkSettings } from '../types'
import { parseSse } from '../utils/parseSse'
import { normaliseChunk, serialiseChunk } from '../utils/chunkUtils'
import { API_BASE } from './apiService'

/** Body shape posted to ``POST /api/chunks/save``. */
export interface SaveChunksPayload {
  filename: string
  mdFilename: string | null
  sourceHash: string | null
  settings: ChunkSettings
  chunks: Chunk[]
}

export interface ChunkSetResult {
  chunks: Chunk[]
  sourceHash: string | null
}

/**
 * Persist a chunk set on the backend.  Returns the basename of the saved
 * JSON file (extracted from the response's full path) so callers can
 * highlight the matching entry in the saved-versions dropdown.
 *
 * Single source of truth for the save body — both the manual "Save chunks"
 * button and the bulk-chunk pipeline route through this function so the
 * payload shape (and the set of fields that participate in the
 * configuration-keyed filename) can never drift between callers.
 */
export async function saveChunks(
  payload: SaveChunksPayload,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API_BASE}/chunks/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      filename: payload.filename,
      md_filename: payload.mdFilename,
      source_hash: payload.sourceHash,
      chunker_type: payload.settings.chunkerType,
      chunker_library: payload.settings.chunkerLibrary,
      chunk_size: payload.settings.chunkSize,
      chunk_overlap: payload.settings.chunkOverlap,
      enable_markdown_sizing: payload.settings.enableMarkdownSizing,
      chunks: payload.chunks.map(serialiseChunk),
    }),
  })
  if (!res.ok) throw new Error(`Save chunks failed: HTTP ${res.status}`)
  const data = await res.json().catch(() => ({} as { path?: string }))
  const path = typeof data.path === 'string' ? data.path : ''
  return path.split(/[\\/]/).pop() ?? ''
}

/** List every saved chunks file for *filename*, newest first. */
export async function listChunksVersions(filename: string): Promise<ChunksVersion[]> {
  const res = await fetch(
    `${API_BASE}/documents/${encodeURIComponent(filename)}/chunks`,
  )
  if (!res.ok) throw new Error(`List chunks failed: HTTP ${res.status}`)
  const data = await res.json() as { versions?: unknown }
  if (!Array.isArray(data.versions)) {
    throw new Error('Invalid chunks versions response')
  }
  return data.versions as ChunksVersion[]
}

/** Load a specific saved chunks JSON file by its filename. */
export async function loadSavedChunksFile(
  filename: string,
  chunksFilename: string,
  signal?: AbortSignal,
): Promise<ChunkSetResult> {
  const res = await fetch(
    `${API_BASE}/documents/${encodeURIComponent(filename)}/chunks/${encodeURIComponent(chunksFilename)}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Load chunks failed: HTTP ${res.status}`)
  const data: { chunks: Chunk[]; source_hash?: string | null } = await res.json()
  return {
    chunks: data.chunks.map(normaliseChunk),
    sourceHash: typeof data.source_hash === 'string' ? data.source_hash : null,
  }
}

/**
 * POST /api/chunk for one or more filenames and consume the SSE stream.
 *
 * For a single filename, returns the resulting chunks straight from the
 * ``file_done`` event.  For batch usage, callers pass ``onFileStart`` /
 * ``onFileDone`` to track progress and the return value is just the first
 * file's chunks (kept for backward compatibility with single-file callers).
 */
export async function chunkSse(
  filenames: string[],
  s: ChunkSettings,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
  onFileStart?: (filename: string, index: number, total: number) => void,
  onFileDone?: (
    filename: string,
    success: boolean,
    chunks: Chunk[],
    mdFilename: string | null,
  ) => void | Promise<void>,
  mdFilename?: string | null,
): Promise<ChunkSetResult> {
  const body: Record<string, unknown> = {
    filenames,
    chunker_type: s.chunkerType,
    chunker_library: s.chunkerLibrary,
    chunk_size: s.chunkSize,
    chunk_overlap: s.chunkOverlap,
    enable_markdown_sizing: s.enableMarkdownSizing,
  }
  // md_filename is only meaningful for a single-document request — the
  // backend ignores it for batch /chunk calls.
  if (filenames.length === 1 && mdFilename) body.md_filename = mdFilename

  const res = await fetch(`${API_BASE}/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  if (!res.body) throw new Error('No response body')

  let firstFileChunks: Chunk[] = []
  let firstFileSourceHash: string | null = null
  let sawBatchDone = false
  for await (const event of parseSse(res.body, onConnectionLost)) {
    if (event.type === 'file_start') {
      onFileStart?.(event.filename as string, event.index as number, event.total as number)
    } else if (event.type === 'file_done') {
      const filename = event.filename as string
      const success = event.success as boolean
      const raw = (event.chunks ?? []) as Chunk[]
      const chunks = raw.map(normaliseChunk)
      const mdFn = (event.md_filename as string | undefined) ?? null
      await onFileDone?.(filename, success, chunks, mdFn)
      if (filename === filenames[0] && success) {
        firstFileChunks = chunks
        firstFileSourceHash = (event.source_hash as string | undefined) ?? null
      }
      if (!success && filenames.length === 1) {
        throw new Error(String(event.error ?? 'Chunking failed'))
      }
    } else if (event.type === 'batch_done') {
      sawBatchDone = true
      break
    } else if (event.type === 'error') {
      throw new Error(String(event.message ?? 'Chunking error'))
    } else if (event.type === 'cancelled') {
      throw new DOMException('Chunking cancelled', 'AbortError')
    }
  }
  if (!sawBatchDone) throw new Error('Chunking stream ended without completion')
  return { chunks: firstFileChunks, sourceHash: firstFileSourceHash }
}
