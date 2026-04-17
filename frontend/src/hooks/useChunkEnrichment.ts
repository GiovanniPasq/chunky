import { useState, useRef, useEffect } from 'react'
import type { Chunk, EnrichmentSettings, EnrichOp } from '../types'
import { apiEnrichChunk, buildEnrichmentBody, API_BASE } from '../services/apiService'
import { parseSse, CONNECTION_LOST_MSG } from '../utils/parseSse'
import { missingEnrichmentModelError } from '../utils/chunkUtils'

// ── Hook ─────────────────────────────────────────────────────────────────────

interface Options {
  chunkEnrichment?: EnrichmentSettings
  chunks: Chunk[] | null
  /** Watched to clear in-progress state when the document changes. */
  content: string
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
  /** Enrich a single chunk by index; shows per-block spinner in chunk viz. */
  handleEnrichChunk: (chunkIndex: number) => Promise<void>
  /** Enrich all selected chunks in one batched SSE call. */
  handleEnrichSelected: () => Promise<void>
}

export function useChunkEnrichment({
  chunkEnrichment,
  chunks,
  content,
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

  // Abort any in-flight enrichment on unmount.
  useEffect(() => {
    return () => {
      singleEnrichAbortRef.current?.abort()
      bulkEnrichAbortRef.current?.abort()
    }
  }, [])

  // Clear per-chunk state when the document content changes (doc switch / reconvert).
  useEffect(() => {
    setEnrichingChunks(new Set())
    setChunkEnrichErrors(new Map())
  }, [content])

  // Clear per-chunk state when chunks become null (rechunk start / doc switch).
  // We don't clear on every chunks update so that concurrent single-chunk
  // enrichments don't lose their loading indicators each time one of them
  // writes its result back into the array.
  useEffect(() => {
    if (chunks === null) {
      setEnrichingChunks(new Set())
      setChunkEnrichErrors(new Map())
    }
  }, [chunks])

  // ── Single-chunk enrichment ──────────────────────────────────────────────

  const handleInterruptChunkEnrich = () => {
    singleEnrichAbortRef.current?.abort()
    bulkEnrichAbortRef.current?.abort()
    setChunkEnrichOp(null)
  }

  const handleEnrichChunk = async (chunkIndex: number) => {
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

    singleEnrichAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    singleEnrichAbortRef.current = abortCtrl

    setChunkEnrichErrors(prev => { const m = new Map(prev); m.delete(chunkIndex); return m })
    setEnrichingChunks(prev => new Set(prev).add(chunkIndex))

    try {
      const result = await apiEnrichChunk(
        chunkEnrichment,
        chunkIndex,
        chunk.content,
        chunk.start ?? 0,
        chunk.end ?? 0,
        (chunk.metadata ?? {}) as Record<string, unknown>,
        abortCtrl.signal,
        () => setChunkEnrichErrors(prev => new Map(prev).set(chunkIndex, CONNECTION_LOST_MSG)),
      )
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
    } finally {
      if (singleEnrichAbortRef.current === abortCtrl) singleEnrichAbortRef.current = null
      setEnrichingChunks(prev => { const s = new Set(prev); s.delete(chunkIndex); return s })
    }
  }

  // ── Bulk chunk enrichment ────────────────────────────────────────────────
  //
  // Sends ALL selected chunks in a single SSE call. The backend processes
  // them with a semaphore (MAX_CONCURRENT_ENRICHMENTS) so chunk_done events
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

    const abortCtrl = new AbortController()
    bulkEnrichAbortRef.current = abortCtrl

    setChunkEnrichOp({ title: 'Chunk Enrichment', detail: '', current: 0, total: indices.length })

    let enrichedCount = 0
    let wasAborted = false

    try {
      const res = await fetch(`${API_BASE}/enrich/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortCtrl.signal,
        body: JSON.stringify(buildEnrichmentBody(chunkEnrichment, { chunks: chunksToEnrich })),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(`HTTP ${res.status}: ${errText}`)
      }

      if (!res.body) throw new Error('No response body')
      for await (const event of parseSse(
        res.body,
        () => setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: CONNECTION_LOST_MSG } : null),
      )) {
        if (event.type === 'chunk_done') {
          enrichedCount++
          const chunk = event.chunk as Record<string, unknown>
          // chunk.index = which chunk in the full array was enriched (may be out of order)
          const chunkIndex = chunk.index as number
          // event.current / event.total = sequential backend counter (always in order)
          const current = event.current as number
          const total = event.total as number

          const latestChunks = chunksRef.current
          onEnrichChunk(chunkIndex, {
            cleaned_chunk: typeof chunk.cleaned_chunk === 'string' ? chunk.cleaned_chunk : (latestChunks?.[chunkIndex]?.cleaned_chunk ?? ''),
            title: typeof chunk.title === 'string' ? chunk.title : (latestChunks?.[chunkIndex]?.title ?? ''),
            context: typeof chunk.context === 'string' ? chunk.context : (latestChunks?.[chunkIndex]?.context ?? ''),
            summary: typeof chunk.summary === 'string' ? chunk.summary : (latestChunks?.[chunkIndex]?.summary ?? ''),
            keywords: Array.isArray(chunk.keywords)
              ? chunk.keywords as string[]
              : latestChunks?.[chunkIndex]?.keywords ?? [],
            questions: Array.isArray(chunk.questions)
              ? chunk.questions as string[]
              : latestChunks?.[chunkIndex]?.questions ?? [],
          })
          setChunkEnrichOp(prev => prev
            ? { ...prev, current, detail: `Enriched ${current} of ${total} chunks` }
            : null
          )
          // Yield to the event loop so React flushes state between consecutive events
          // (React 18 automatic batching would otherwise collapse all updates to one render).
          await new Promise<void>(r => setTimeout(r, 0))

        } else if (event.type === 'chunk_error') {
          setChunkEnrichOp(prev => prev
            ? { ...prev, current: event.current as number, detail: `Enriched ${event.current} of ${event.total} chunks` }
            : null
          )
        } else if (event.type === 'done' || event.type === 'cancelled') {
          break
        } else if (event.type === 'error') {
          throw new Error(String(event.message ?? 'Enrichment error'))
        }
      }
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
      setChunkEnrichOp(null)
      bulkEnrichAbortRef.current = null
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
