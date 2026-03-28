import { useState, useRef, useEffect } from 'react'
import type { Chunk, EnrichmentSettings, EnrichOp } from '../types'
import { apiEnrichChunk, buildEnrichmentBody, API_BASE } from '../services/apiService'
import { parseSse, CONNECTION_LOST_MSG } from '../utils/parseSse'

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
}: Options): UseChunkEnrichmentReturn {
  const [chunkEnrichOp, setChunkEnrichOp] = useState<EnrichOp | null>(null)
  const [enrichingChunks, setEnrichingChunks] = useState<Set<number>>(new Set())
  const [chunkEnrichErrors, setChunkEnrichErrors] = useState<Map<number, string>>(new Map())
  const chunkEnrichAbortRef = useRef<AbortController | null>(null)

  // Refs for values used inside long-running async handlers so they always
  // see the latest state without being in the closure's capture list.
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks
  const selectedChunksRef = useRef(selectedChunks)
  selectedChunksRef.current = selectedChunks

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
    chunkEnrichAbortRef.current?.abort()
    setChunkEnrichOp(null)
  }

  const handleEnrichChunk = async (chunkIndex: number) => {
    const currentChunks = chunksRef.current
    if (!chunkEnrichment?.model) {
      setChunkEnrichErrors(prev => new Map(prev).set(
        chunkIndex,
        'Configure Chunk Enrichment settings (model) in Settings → Enrichment tab.',
      ))
      return
    }
    if (!currentChunks) return
    const chunk = currentChunks[chunkIndex]
    if (!chunk) return

    setChunkEnrichErrors(prev => { const m = new Map(prev); m.delete(chunkIndex); return m })
    setEnrichingChunks(prev => new Set([...prev, chunkIndex]))

    try {
      const result = await apiEnrichChunk(
        chunkEnrichment,
        chunkIndex,
        chunk.content,
        chunk.start ?? 0,
        chunk.end ?? 0,
        (chunk.metadata ?? {}) as Record<string, unknown>,
      )
      onEnrichChunk(chunkIndex, {
        cleaned_chunk: (result.cleaned_chunk as string) || chunk.cleaned_chunk,
        title: (result.title as string) || chunk.title,
        context: (result.context as string) || chunk.context,
        summary: (result.summary as string) || chunk.summary,
        keywords: Array.isArray(result.keywords) ? result.keywords as string[] : chunk.keywords,
        questions: Array.isArray(result.questions) ? result.questions as string[] : chunk.questions,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Enrichment failed'
      setChunkEnrichErrors(prev => new Map(prev).set(chunkIndex, msg))
    } finally {
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
      setEnrichError('Configure Chunk Enrichment settings (model) in Settings → Enrichment tab.')
      return
    }
    if (!currentChunks || currentSelected.size === 0) return

    const indices = Array.from(currentSelected).sort((a, b) => a - b)
    const chunksToEnrich = indices.map(i => ({
      index: i,
      content: currentChunks[i].content,
      start: currentChunks[i].start ?? 0,
      end: currentChunks[i].end ?? 0,
      metadata: (currentChunks[i].metadata ?? {}) as Record<string, unknown>,
    }))

    const abortCtrl = new AbortController()
    chunkEnrichAbortRef.current = abortCtrl

    setChunkEnrichOp({ title: 'Chunk Enrichment', detail: '', current: 0, total: indices.length })

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

      for await (const event of parseSse(
        res.body!,
        () => setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: CONNECTION_LOST_MSG } : null),
      )) {
        if (event.type === 'chunk_done') {
          const chunk = event.chunk as Record<string, unknown>
          // chunk.index = which chunk in the full array was enriched (may be out of order)
          const chunkIndex = chunk.index as number
          // event.current / event.total = sequential backend counter (always in order)
          const current = event.current as number
          const total = event.total as number

          const latestChunks = chunksRef.current
          onEnrichChunk(chunkIndex, {
            cleaned_chunk: (chunk.cleaned_chunk as string) || latestChunks?.[chunkIndex]?.cleaned_chunk,
            title: (chunk.title as string) || latestChunks?.[chunkIndex]?.title,
            context: (chunk.context as string) || latestChunks?.[chunkIndex]?.context,
            summary: (chunk.summary as string) || latestChunks?.[chunkIndex]?.summary,
            keywords: Array.isArray(chunk.keywords)
              ? chunk.keywords as string[]
              : latestChunks?.[chunkIndex]?.keywords,
            questions: Array.isArray(chunk.questions)
              ? chunk.questions as string[]
              : latestChunks?.[chunkIndex]?.questions,
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
            ? { ...prev, current: event.current as number }
            : null
          )
        } else if (event.type === 'done' || event.type === 'cancelled') {
          break
        } else if (event.type === 'error') {
          throw new Error(String(event.message ?? 'Enrichment error'))
        }
      }
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') {
        // User interrupted — no error message needed
      } else {
        const msg = err instanceof Error ? err.message : 'Stream error'
        setChunkEnrichOp(prev => prev ? { ...prev, errorMessage: msg } : null)
        // Keep modal open briefly so the user can read the error before it dismisses.
        await new Promise(r => setTimeout(r, 2000))
      }
    } finally {
      setChunkEnrichOp(null)
      chunkEnrichAbortRef.current = null
      setSelectedChunks(new Set())
    }
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
