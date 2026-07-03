import type {
  Capabilities,
  Chunk,
  DocumentSummary,
  DocumentSummaryResponse,
  EnrichmentSettings,
} from '../types'
import { parseSse } from '../utils/parseSse'
import { normaliseChunk } from '../utils/chunkUtils'
import { DEFAULT_ENRICHMENT_BASE_URL, DEFAULT_ENRICHMENT_TEMPERATURE } from '../hooks/useSettings'
import { METADATA_FETCH_TIMEOUT_MS } from '../config'

export const API_BASE = '/api'

// ─────────────────────────────────────────────────────────────────────────────
// Document metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentMetadataEntry {
  filename: string
  has_markdown: boolean
  /** Saved Markdown contains VLM failed-page placeholders and can be previewed. */
  has_failures?: boolean
  /** VLM checkpoint exists; an interrupted conversion can be resumed. */
  has_checkpoint?: boolean
}

/**
 * Fetch the current document-list metadata used by the sidebar to flag
 * which docs have a converted MD, failed VLM pages, or resumable VLM checkpoints.
 *
 * Returns an empty array on any failure (network / abort / non-2xx).
 * Caller is expected to feed the array into setDocsWithMarkdown +
 * setDocsWithFailures; the shape is kept simple on purpose so the
 * Set-building logic stays inline at the call site (it's the noisy
 * part the helper is replacing — duplicating it across three effects
 * is what hurts).
 *
 * ``errorContext`` is appended to the console.error message so the
 * three call sites stay distinguishable in the dev console.
 */
export async function fetchDocumentMetadata(
  errorContext: string,
): Promise<DocumentMetadataEntry[]> {
  try {
    const res = await fetch('/api/documents/metadata', {
      signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    })
    return res.ok ? await res.json() : []
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name
    if (name !== 'AbortError' && name !== 'TimeoutError') {
      console.error(`Failed to ${errorContext}:`, err)
    }
    return []
  }
}

/**
 * Map a wire-level converter name (the value used by the /api/convert
 * endpoint) to the lowercase token the backend uses for filenames and
 * dropdown identifiers.  Kept in sync with
 * ``backend.utils.naming.CONVERTER_NORMALIZATION``; only the
 * identity-different entries need to appear here.
 */
const CONVERTER_FILENAME_TOKEN: Record<string, string> = {
  pymupdf: 'pymupdf4llm',
}

export function converterFilenameToken(converter: string | undefined | null): string | null {
  if (!converter) return null
  return CONVERTER_FILENAME_TOKEN[converter] ?? converter
}

/**
 * Derive the MD-source token (e.g. ``"docling"``, ``"uploaded"``) from a
 * Markdown filename without depending on ``availableMarkdowns`` being
 * populated.  Used by the chunks auto-link logic so the source is known
 * the moment ``documentData.md_filename`` updates, not only after the
 * version listing has loaded.
 */
export function mdSourceFromFilename(
  mdFilename: string | null | undefined,
  pdfFilename: string | null | undefined,
): string | null {
  if (!mdFilename) return null
  const mdStem = mdFilename.replace(/\.md$/i, '')
  const docStem = (pdfFilename ?? '').replace(/\.pdf$/i, '')
  if (docStem) {
    const prefix = `${docStem}_`
    if (mdStem.startsWith(prefix)) {
      const token = mdStem.slice(prefix.length)
      if (token) return token
    }
  }
  return 'uploaded'
}

/**
 * Build the request body for enrichment endpoints.
 * Applies defaults for optional fields so callers don't need to repeat them.
 */
export function buildEnrichmentBody(
  settings: EnrichmentSettings,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    settings: {
      model: settings.model,
      base_url: settings.base_url ?? DEFAULT_ENRICHMENT_BASE_URL,
      api_key: settings.api_key ?? 'ollama',
      temperature: settings.temperature ?? DEFAULT_ENRICHMENT_TEMPERATURE,
      user_prompt: settings.user_prompt,
    },
  }
}

export const capabilityService = {
  async get(): Promise<Capabilities> {
    const res = await fetch(`${API_BASE}/capabilities`)
    if (!res.ok) throw new Error('Failed to fetch capabilities')
    return res.json()
  },
}

/**
 * Per-piece pipeline event payloads streamed by /api/enrich/markdown/pipeline.
 *
 * The orchestrator emits ``cleanup_done``, ``split_done``, then a sequence of
 * ``piece_start`` / ``piece_done`` events as each piece resolves, ending with
 * ``done`` (containing the assembled enriched content and stats) or ``error``
 * / ``cancelled``.  The hook that consumes this stream uses these payloads to
 * drive a progress UI and the diff-preview modal.
 */
export interface PipelineProgress {
  /** Result of the deterministic cleanup pass. */
  cleanup?: Record<string, number>
  /** Total number of pieces produced by the structure-aware splitter. */
  totalPieces: number
  /** Count of pieces that have finished (cache hit + LLM success + LLM failure). */
  completedPieces: number
  /** Count of pieces currently being processed by the LLM. */
  inFlight: number
  /** Count of pieces served from the checkpoint cache (subset of completedPieces). */
  cachedPieces: number
  /** 1-indexed piece numbers whose LLM call failed and fell back to the post-cleanup original. */
  failedPieces: number[]
}

export interface PipelineResult {
  enrichedContent: string
  stats: {
    pieces: number
    cached_pieces: number
    failed_pieces: number[]
    cleanup: Record<string, number>
    summary?: { present: boolean }
  }
}

export interface ChunkEnrichmentProgress {
  current: number
  total: number
  chunk?: Chunk
}

export type ChunkEnrichmentInput = Pick<Chunk, 'index' | 'content'> &
  Partial<Pick<Chunk, 'start' | 'end' | 'metadata'>>

export interface ChunkEnrichmentBatchResult {
  chunks: Chunk[]
  succeeded: number
  failed: number
}

/**
 * Run the full enrichment pipeline (deterministic cleanup + structure-aware split +
 * per-piece LLM with rolling context + per-piece checkpoint) on a stored
 * Markdown file.  Streams progress to the caller via ``onProgress`` and
 * returns the enriched content + stats once the run completes.
 *
 * Throws on terminal errors.  Throws ``DOMException(AbortError)`` when the
 * caller aborts via the supplied ``signal``.
 */
export async function apiEnrichMarkdownPipeline(
  filename: string,
  documentName: string,
  settings: EnrichmentSettings,
  useCheckpoint: boolean,
  useSummary: boolean,
  onProgress: (state: PipelineProgress) => void,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
): Promise<PipelineResult> {
  const res = await fetch(`${API_BASE}/enrich/markdown/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, {
      filename,
      document_name: documentName,
      use_checkpoint: useCheckpoint,
      use_summary: useSummary,
    })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Pipeline enrichment failed ${res.status}: ${errText}`)
  }
  if (!res.body) throw new Error('No response body')

  const state: PipelineProgress = {
    totalPieces: 0,
    completedPieces: 0,
    inFlight: 0,
    cachedPieces: 0,
    failedPieces: [],
  }

  for await (const event of parseSse(res.body, onConnectionLost)) {
    switch (event.type) {
      case 'start':
        break
      case 'cleanup_done':
        state.cleanup = event.report as Record<string, number> | undefined
        onProgress({ ...state })
        break
      case 'split_done':
        state.totalPieces = (event.pieces as number) ?? 0
        onProgress({ ...state })
        break
      case 'piece_start':
        state.inFlight += 1
        onProgress({ ...state })
        break
      case 'piece_done':
        state.inFlight = Math.max(0, state.inFlight - 1)
        state.completedPieces += 1
        if (event.cached) state.cachedPieces += 1
        if (event.succeeded === false) {
          state.failedPieces = [...state.failedPieces, event.index as number]
        }
        onProgress({ ...state })
        break
      case 'done':
        return {
          enrichedContent: event.enriched_content as string,
          stats: event.stats as PipelineResult['stats'],
        }
      case 'error':
        throw new Error(String(event.message ?? 'Pipeline enrichment error'))
      case 'cancelled':
        throw new DOMException('Pipeline enrichment cancelled', 'AbortError')
    }
  }
  throw new Error('Stream ended without a done event')
}

/**
 * Enrich a single chunk via SSE (sends a one-item batch).
 * Returns the enriched chunk fields as a plain object.
 * Throws on error; throws DOMException(AbortError) if cancelled/aborted.
 */
export async function apiEnrichChunk(
  settings: EnrichmentSettings,
  index: number,
  content: string,
  start: number,
  end: number,
  metadata: Record<string, unknown>,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
  mdFilename?: string,
  documentName?: string,
): Promise<Record<string, unknown>> {
  const result = await apiEnrichChunks(
    settings,
    [{ index, content, start, end, metadata }],
    mdFilename,
    documentName,
    signal,
    undefined,
    onConnectionLost,
  )
  if (result.chunks.length > 0) return result.chunks[0] as unknown as Record<string, unknown>
  throw new Error('Chunk enrichment produced no result')
}

/**
 * Enrich one or more chunks via SSE.
 *
 * ``mdFilename`` lets the backend attach cached document summary and source
 * Markdown context windows.  Absent (or no cached context): chunks are
 * enriched in isolation.
 */
export async function apiEnrichChunks(
  settings: EnrichmentSettings,
  chunks: ChunkEnrichmentInput[],
  mdFilename?: string | null,
  documentName?: string | null,
  signal?: AbortSignal,
  onProgress?: (progress: ChunkEnrichmentProgress) => void,
  onConnectionLost?: () => void,
): Promise<ChunkEnrichmentBatchResult> {
  if (chunks.length === 0) return { chunks: [], succeeded: 0, failed: 0 }

  const res = await fetch(`${API_BASE}/enrich/chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, {
      chunks: chunks.map(c => ({
        index: c.index,
        content: c.content,
        start: c.start ?? 0,
        end: c.end ?? 0,
        metadata: c.metadata ?? {},
      })),
      ...(mdFilename ? { md_filename: mdFilename } : {}),
      ...(documentName ? { document_name: documentName } : {}),
    })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Chunk enrichment failed ${res.status}: ${errText}`)
  }
  if (!res.body) throw new Error('No response body')
  const enriched: Chunk[] = []
  let succeeded = 0
  let failed = 0
  for await (const event of parseSse(res.body, onConnectionLost)) {
    if (event.type === 'chunk_done') {
      succeeded++
      const chunk = normaliseChunk(event.chunk as Partial<Chunk> & { index: number; content: string })
      enriched.push(chunk)
      onProgress?.({
        current: (event.current as number) ?? succeeded + failed,
        total: (event.total as number) ?? chunks.length,
        chunk,
      })
    } else if (event.type === 'chunk_error') {
      failed++
      onProgress?.({
        current: (event.current as number) ?? succeeded + failed,
        total: (event.total as number) ?? chunks.length,
      })
    } else if (event.type === 'done') {
      return {
        chunks: enriched,
        succeeded: (event.succeeded as number | undefined) ?? succeeded,
        failed: chunks.length - ((event.succeeded as number | undefined) ?? succeeded),
      }
    }
    if (event.type === 'error') throw new Error(String(event.message ?? 'Chunk enrichment error'))
    if (event.type === 'cancelled') throw new DOMException('Chunk enrichment cancelled', 'AbortError')
  }
  throw new Error('Stream ended without a done event')
}


// ---------------------------------------------------------------------------
// Document summary endpoints
// ---------------------------------------------------------------------------

/**
 * Fetch the cached document summary for a markdown variant.  Returns
 * ``null`` when no summary exists on disk — the review modal interprets
 * that as "no summary yet, generate one to continue".
 *
 * Throws on non-404 errors.
 */
export async function apiGetSummary(
  filename: string,
  documentName: string,
): Promise<DocumentSummaryResponse | null> {
  const url = `${API_BASE}/enrich/summary?filename=${encodeURIComponent(filename)}&document_name=${encodeURIComponent(documentName)}`
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Load summary failed ${res.status}: ${errText}`)
  }
  return res.json()
}

/**
 * Persist a user-edited summary.  The backend tags the record with
 * ``user_edited=true`` so future enrichment runs treat the edit as
 * authoritative until the next explicit Regenerate.
 */
export async function apiPutSummary(
  filename: string,
  documentName: string,
  summary: DocumentSummary,
  signal?: AbortSignal,
): Promise<DocumentSummaryResponse> {
  const res = await fetch(`${API_BASE}/enrich/summary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, document_name: documentName, summary }),
    signal,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Save summary failed ${res.status}: ${errText}`)
  }
  return res.json()
}


/**
 * Streamed progress events from ``/api/enrich/summary/generate``.  The
 * shape matches the SSE wire payloads so the review modal can show a
 * sensible progress UI while the map-reduce runs.
 */
export interface SummaryGenerateProgress {
  stage: 'idle' | 'cleanup' | 'splitting' | 'extracting' | 'reducing' | 'done'
  totalPieces: number
  completedExtractions: number
  cleanup?: Record<string, number>
}

/**
 * Trigger summary generation.  When ``force`` is false and a cached
 * record exists the backend short-circuits and returns it without LLM
 * calls; when ``force`` is true it discards the cache and rebuilds via
 * map-reduce.  Streams progress; resolves with the persisted record.
 *
 * Throws on terminal errors.  Throws ``DOMException(AbortError)`` when
 * the caller aborts via ``signal``.
 */
export async function apiGenerateSummary(
  filename: string,
  documentName: string,
  settings: EnrichmentSettings,
  force: boolean,
  onProgress: (state: SummaryGenerateProgress) => void,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
): Promise<DocumentSummaryResponse> {
  const res = await fetch(`${API_BASE}/enrich/summary/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, {
      filename,
      document_name: documentName,
      force,
    })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Summary generation failed ${res.status}: ${errText}`)
  }
  if (!res.body) throw new Error('No response body')

  const state: SummaryGenerateProgress = {
    stage: 'idle',
    totalPieces: 0,
    completedExtractions: 0,
  }

  for await (const event of parseSse(res.body, onConnectionLost)) {
    switch (event.type) {
      case 'start':
        state.stage = 'cleanup'
        onProgress({ ...state })
        break
      case 'cleanup_done':
        state.cleanup = event.report as Record<string, number> | undefined
        state.stage = 'splitting'
        onProgress({ ...state })
        break
      case 'split_done':
        state.totalPieces = (event.pieces as number) ?? 0
        state.stage = 'extracting'
        onProgress({ ...state })
        break
      case 'summary_progress':
        state.totalPieces = (event.total as number) ?? state.totalPieces
        state.completedExtractions = (event.current as number) ?? state.completedExtractions
        onProgress({ ...state })
        break
      case 'summary_ready':
        state.stage = 'reducing'
        onProgress({ ...state })
        break
      case 'done':
        state.stage = 'done'
        onProgress({ ...state })
        return event.summary as DocumentSummaryResponse
      case 'error':
        throw new Error(String(event.message ?? 'Summary generation error'))
      case 'cancelled':
        throw new DOMException('Summary generation cancelled', 'AbortError')
    }
  }
  throw new Error('Stream ended without a done event')
}
