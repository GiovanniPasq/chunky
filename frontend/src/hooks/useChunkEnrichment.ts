import { useState, useRef, useEffect } from 'react'
import type { Chunk, EnrichmentSettings, EnrichOp } from '../types'
import { apiEnrichChunk, apiEnrichChunks } from '../services/apiService'
import { CONNECTION_LOST_MSG } from '../utils/parseSse'
import { missingEnrichmentModelError } from '../utils/chunkUtils'
import { isCurrentChunkRevision } from '../utils/chunkUtils'

// ── Hook ─────────────────────────────────────────────────────────────────────

interface Options {
  documentName?: string
  chunkRevision: number
  chunkEnrichment?: EnrichmentSettings
  chunks: Chunk[] | null
  /** Watched to clear in-progress state when the document changes. */
  content: string
  /**
   * Active Markdown variant filename, e.g. ``"report_vlm.md"``. When
   * provided, chunk enrichment can use cached document summary and nearby
   * source Markdown as read-only context.
   */
  mdFilename?: string
  selectedChunks: Set<number>
  onEnrichChunk: (index: number, updates: Partial<Chunk>) => void
  setEnrichError: (msg: string | null) => void
  setSelectedChunks: (s: Set<number>) => void
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export interface UseChunkEnrichmentReturn {
  chunkEnrichOp: EnrichOp | null
  /** Set of chunk indices currently being enriched (single-chunk flow). */
  enrichingChunks: Set<number>
  /** Per-chunk error messages (single-chunk flow). */
  chunkEnrichErrors: Map<number, string>
  handleInterruptChunkEnrich: () => void
  /** Enrich a single chunk by index; blocks via ProgressModal and shows a per-block spinner. */
  handleEnrichChunk: (chunkIndex: number) => Promise<void>
  /** Enrich all selected chunks in one batched SSE call. */
  handleEnrichSelected: () => Promise<void>
}

export function useChunkEnrichment({
  documentName,
  chunkRevision,
  chunkEnrichment,
  chunks,
  content,
  mdFilename,
  selectedChunks,
  onEnrichChunk,
  setEnrichError,
  setSelectedChunks,
  onSuccess,
  onError,
}: Options): UseChunkEnrichmentReturn {
  const [chunkEnrichOp, setChunkEnrichOp] = useState<EnrichOp | null>(null)
  const [enrichingChunks, setEnrichingChunks] = useState<Set<number>>(new Set())
  const [chunkEnrichErrors, setChunkEnrichErrors] = useState<Map<number, string>>(new Map())
  // Separate abort controllers so that starting one flow never silently
  // orphans the other (shared ref caused: bulk's finally clearing single's ref,
  // and interrupt only aborting whichever wrote last).
  const singleEnrichAbortRef = useRef<AbortController | null>(null)
  const bulkEnrichAbortRef = useRef<AbortController | null>(null)

  // Refs for values used inside long-running async handlers so they always
  // see the latest state without being in the closure's capture list.
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks
  const selectedChunksRef = useRef(selectedChunks)
  selectedChunksRef.current = selectedChunks
  const chunkRevisionRef = useRef(chunkRevision)
  chunkRevisionRef.current = chunkRevision

  // Abort any in-flight enrichment on unmount.
  useEffect(() => {
    return () => {
      singleEnrichAbortRef.current?.abort()
      bulkEnrichAbortRef.current?.abort()
      singleEnrichAbortRef.current = null
      bulkEnrichAbortRef.current = null
    }
  }, [])

  // Clear per-chunk state when the document content changes (doc switch / reconvert).
  useEffect(() => {
    singleEnrichAbortRef.current?.abort()
    bulkEnrichAbortRef.current?.abort()
    singleEnrichAbortRef.current = null
    bulkEnrichAbortRef.current = null
    setChunkEnrichOp(null)
    setEnrichingChunks(new Set())
    setChunkEnrichErrors(new Map())
  }, [content, chunkRevision])

  // Clear per-chunk state when chunks become null (rechunk start / doc switch).
  // We don't clear on every chunks update so that concurrent single-chunk
  // enrichments don't lose their loading indicators each time one of them
  // writes its result back into the array.
  //
  // We also abort any in-flight enrichment requests.  Without this, a doc
  // switch (or rechunk) made while enrichment is in flight would let the late
  // response land via ``onEnrichChunk(index, …)`` AFTER the new doc's chunks
  // populated — silently writing the old doc's enrichment into the new doc's
  // chunk at the same index. The modal blocks normal UI paths, and this effect
  // is the final ownership guard for programmatic state changes.
  useEffect(() => {
    if (chunks === null) {
      singleEnrichAbortRef.current?.abort()
      bulkEnrichAbortRef.current?.abort()
      singleEnrichAbortRef.current = null
      bulkEnrichAbortRef.current = null
      setChunkEnrichOp(null)
      setEnrichingChunks(new Set())
      setChunkEnrichErrors(new Map())
    }
  }, [chunks])

  // ── Single-chunk enrichment ──────────────────────────────────────────────

  const handleInterruptChunkEnrich = () => {
    singleEnrichAbortRef.current?.abort()
    bulkEnrichAbortRef.current?.abort()
    singleEnrichAbortRef.current = null
    bulkEnrichAbortRef.current = null
    setChunkEnrichOp(null)
  }

  const handleEnrichChunk = async (chunkIndex: number) => {
    if (bulkEnrichAbortRef.current) return
    const currentChunks = chunksRef.current
    if (!chunkEnrichment?.model) {
      setChunkEnrichErrors(prev => new Map(prev).set(
        chunkIndex,
        missingEnrichmentModelError('Chunk Enrichment settings'),
      ))
      return
    }
    if (!currentChunks) return
    const chunk = currentChunks[chunkIndex]
    if (!chunk) return
    const ownerRevision = chunkRevisionRef.current

    singleEnrichAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    singleEnrichAbortRef.current = abortCtrl

    setChunkEnrichErrors(prev => { const m = new Map(prev); m.delete(chunkIndex); return m })
    setEnrichingChunks(prev => new Set(prev).add(chunkIndex))
    setChunkEnrichOp({
      title: 'Chunk Enrichment',
      detail: `Chunk ${chunkIndex + 1} of ${currentChunks.length}`,
      current: 0,
      total: 0,
    })

    try {
      const result = await apiEnrichChunk(
        chunkEnrichment,
        chunkIndex,
        chunk.content,
        chunk.start ?? 0,
        chunk.end ?? 0,
        (chunk.metadata ?? {}) as Record<string, unknown>,
        abortCtrl.signal,
        () => {
          setChunkEnrichErrors(prev => new Map(prev).set(chunkIndex, CONNECTION_LOST_MSG))
          if (singleEnrichAbortRef.current === abortCtrl) {
            setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: CONNECTION_LOST_MSG } : null)
          }
        },
        mdFilename,
        documentName,
      )
      if (!isCurrentChunkRevision(ownerRevision, chunkRevisionRef.current)) return
      onEnrichChunk(chunkIndex, {
        cleaned_chunk: (result.cleaned_chunk as string) ?? chunk.cleaned_chunk,
        title: (result.title as string) ?? chunk.title,
        context: (result.context as string) ?? chunk.context,
        summary: (result.summary as string) ?? chunk.summary,
        keywords: Array.isArray(result.keywords) ? result.keywords as string[] : chunk.keywords,
        questions: Array.isArray(result.questions) ? result.questions as string[] : chunk.questions,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      const msg = err instanceof Error ? err.message : 'Enrichment failed'
      setChunkEnrichErrors(prev => new Map(prev).set(chunkIndex, msg))
      if (singleEnrichAbortRef.current === abortCtrl) {
        setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: msg } : null)
        await new Promise<void>(r => {
          const id = setTimeout(r, 2000)
          abortCtrl.signal.addEventListener('abort', () => { clearTimeout(id); r() }, { once: true })
        })
      }
    } finally {
      if (singleEnrichAbortRef.current === abortCtrl) {
        singleEnrichAbortRef.current = null
        setChunkEnrichOp(null)
      }
      setEnrichingChunks(prev => { const s = new Set(prev); s.delete(chunkIndex); return s })
    }
  }

  // ── Bulk chunk enrichment ────────────────────────────────────────────────
  //
  // Sends ALL selected chunks in a single SSE call. The backend processes
  // them with a semaphore (ENRICHMENT_MAX_CONCURRENT_CHUNKS) so chunk_done events
  // may arrive OUT OF ORDER relative to the original selection.
  //
  // Correctness guarantees:
  //   • chunk.index from the server identifies WHICH chunk was enriched →
  //     used to route onEnrichChunk, independent of arrival order.
  //   • event.current / event.total are the backend's monotonic counters →
  //     used for the progress bar and detail text.
  //   • chunksRef.current provides the latest fallback values; since we look
  //     up by index, a completed chunk never pollutes another.

  const handleEnrichSelected = async () => {
    const currentChunks = chunksRef.current
    const currentSelected = selectedChunksRef.current

    if (!chunkEnrichment?.model) {
      setEnrichError(missingEnrichmentModelError('Chunk Enrichment settings'))
      return
    }
    if (!currentChunks || currentSelected.size === 0) return

    // A single-chunk request and a batch request must never race to write
    // enrichment fields for the same chunk set. Batch ownership wins.
    singleEnrichAbortRef.current?.abort()
    singleEnrichAbortRef.current = null

    const indices = Array.from(currentSelected).sort((a, b) => a - b)
    const chunksToEnrich = indices
      .filter(i => i < currentChunks.length)
      .map(i => ({
        index: i,
        content: currentChunks[i].content,
        start: currentChunks[i].start ?? 0,
        end: currentChunks[i].end ?? 0,
        metadata: (currentChunks[i].metadata ?? {}) as Record<string, unknown>,
      }))
    if (chunksToEnrich.length === 0) return
    const ownerRevision = chunkRevisionRef.current

    bulkEnrichAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    bulkEnrichAbortRef.current = abortCtrl

    setChunkEnrichOp({ title: 'Chunk Enrichment', detail: '', current: 0, total: chunksToEnrich.length })

    let enrichedCount = 0
    let wasAborted = false

    try {
      const result = await apiEnrichChunks(
        chunkEnrichment,
        chunksToEnrich,
        mdFilename,
        documentName,
        abortCtrl.signal,
        ({ current, total, chunk }) => {
          if (!isCurrentChunkRevision(ownerRevision, chunkRevisionRef.current)) return
          if (!chunk) {
            setChunkEnrichOp(prev => prev
              ? { ...prev, current, detail: `Enriched ${current} of ${total} chunks` }
              : null
            )
            return
          }
          enrichedCount++
          const chunkIndex = chunk.index
          const latestChunks = chunksRef.current
          onEnrichChunk(chunkIndex, {
            cleaned_chunk: typeof chunk.cleaned_chunk === 'string' ? chunk.cleaned_chunk : (latestChunks?.[chunkIndex]?.cleaned_chunk ?? ''),
            title: typeof chunk.title === 'string' ? chunk.title : (latestChunks?.[chunkIndex]?.title ?? ''),
            context: typeof chunk.context === 'string' ? chunk.context : (latestChunks?.[chunkIndex]?.context ?? ''),
            summary: typeof chunk.summary === 'string' ? chunk.summary : (latestChunks?.[chunkIndex]?.summary ?? ''),
            keywords: Array.isArray(chunk.keywords)
              ? chunk.keywords
              : latestChunks?.[chunkIndex]?.keywords ?? [],
            questions: Array.isArray(chunk.questions)
              ? chunk.questions
              : latestChunks?.[chunkIndex]?.questions ?? [],
          })
          setChunkEnrichOp(prev => prev
            ? { ...prev, current, detail: `Enriched ${current} of ${total} chunks` }
            : null
          )
        },
        () => setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: CONNECTION_LOST_MSG } : null),
      )
      if (!isCurrentChunkRevision(ownerRevision, chunkRevisionRef.current)) return
      enrichedCount = result.succeeded
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        wasAborted = true
      } else {
        const msg = err instanceof Error ? err.message : 'Stream error'
        setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: msg } : null)
        // Keep modal open briefly so the user can read the error, but respect abort/unmount.
        await new Promise<void>(r => {
          const id = setTimeout(r, 2000)
          abortCtrl.signal.addEventListener('abort', () => { clearTimeout(id); r() }, { once: true })
        })
      }
    } finally {
      if (bulkEnrichAbortRef.current === abortCtrl) {
        setChunkEnrichOp(null)
        bulkEnrichAbortRef.current = null
      }
      setSelectedChunks(new Set())
    }

    const failedCount = indices.length - enrichedCount
    if (enrichedCount > 0) onSuccess?.(`Enriched ${enrichedCount} chunk${enrichedCount !== 1 ? 's' : ''} ✓`)
    if (failedCount > 0 && !wasAborted) onError?.(`${failedCount} chunk${failedCount !== 1 ? 's' : ''} failed to enrich`)
  }

  return {
    chunkEnrichOp,
    enrichingChunks,
    chunkEnrichErrors,
    handleInterruptChunkEnrich,
    handleEnrichChunk,
    handleEnrichSelected,
  }
}
