import { useRef, useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Chunk, EnrichmentSettings } from '../../types'
import ChunkEditModal from '../chunks/ChunkEditModal'
import ProgressModal from '../modals/ProgressModal'
import './MarkdownViewer.css'

interface Props {
  content: string
  scale?: number
  onScaleChange: (s: number) => void
  padding?: number
  onPaddingChange: (p: number) => void
  scrollSyncEnabled?: boolean
  chunks?: Chunk[] | null
  chunkVisualizationEnabled?: boolean
  onChunkEdit: (index: number, content: string) => void
  onEnrichChunk: (index: number, updates: Partial<Chunk>) => void
  onDeleteChunk: (index: number) => void
  onDeleteChunks: (indices: Set<number>) => void
  onMergeChunks: (indices: number[]) => void
  onSaveMarkdown: (content: string) => void
  onSaveChunks: () => void
  onDeleteMarkdown: () => void
  savingMd: boolean
  savingChunks: boolean
  chunksReady: boolean
  chunking?: boolean
  onCancelChunking?: () => void
  sectionEnrichment?: EnrichmentSettings
  chunkEnrichment?: EnrichmentSettings
}

interface MdBlock {
  heading: string
  content: string
  startLine: number
  endLine: number
}

interface EnrichOp {
  title: string
  detail: string
  current: number
  total: number
  errorMessage?: string
}

const CHUNK_COLORS = [
  'rgba(139, 69, 19, 0.12)', 'rgba(61, 107, 39, 0.12)', 'rgba(204, 34, 0, 0.09)',
  'rgba(180, 140, 60, 0.15)', 'rgba(30, 90, 140, 0.10)', 'rgba(210, 105, 30, 0.13)',
  'rgba(90, 50, 120, 0.09)', 'rgba(20, 110, 100, 0.11)', 'rgba(160, 60, 30, 0.12)',
  'rgba(60, 120, 60, 0.12)',
]

const CHUNK_BORDER_COLORS = [
  '#8B4513', '#3D6B27', '#CC2200', '#B48C3C', '#1E5A8C',
  '#D2691E', '#5A3278', '#146E64', '#A03C1E', '#3C783C',
]

const API = '/api'

// ── SSE stream parser ──────────────────────────────────────────────────────

const SSE_SILENT_MS = 60_000
const CONNECTION_LOST_MSG =
  'Connection lost — the operation may have been interrupted. You can safely start a new conversion.'

/**
 * Async generator that yields parsed JSON events from an SSE ReadableStream.
 *
 * @param onSilent  Called when no bytes have been received for silentMs ms.
 */
async function* parseSse(
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
    silentTimer = setTimeout(() => { silentFired = true; onSilent() }, silentMs)
  }

  try {
    armTimer()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armTimer()
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue
        try { yield JSON.parse(part.slice(6)) } catch { /* skip malformed frames */ }
      }
    }
  } finally {
    if (silentTimer !== null) clearTimeout(silentTimer)
    reader.cancel()
  }
}

// ── Enrichment helpers (domain) ────────────────────────────────────────────

function buildEnrichmentBody(settings: EnrichmentSettings, extra: Record<string, unknown>) {
  return {
    ...extra,
    settings: {
      model: settings.model,
      base_url: settings.base_url ?? 'http://localhost:11434/v1',
      api_key: settings.api_key ?? 'ollama',
      temperature: settings.temperature ?? 0.3,
      user_prompt: settings.user_prompt,
    },
  }
}

/**
 * Enrich a single markdown section. Returns the enriched content string.
 * Throws on error; throws DOMException(AbortError) if cancelled/aborted.
 */
async function apiEnrichMarkdown(
  settings: EnrichmentSettings,
  content: string,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
): Promise<string> {
  const res = await fetch(`${API}/enrich/markdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, { content })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Enrichment failed ${res.status}: ${errText}`)
  }
  for await (const event of parseSse(res.body!, onConnectionLost)) {
    if (event.type === 'done') return event.enriched_content as string
    if (event.type === 'error') throw new Error(String(event.message ?? 'Enrichment error'))
    if (event.type === 'cancelled') throw new DOMException('Enrichment cancelled', 'AbortError')
  }
  throw new Error('Stream ended without a done event')
}

/**
 * Enrich a single chunk. Returns the enriched chunk fields.
 * Throws on error; throws DOMException(AbortError) if cancelled/aborted.
 */
async function apiEnrichChunk(
  settings: EnrichmentSettings,
  index: number,
  content: string,
  start: number,
  end: number,
  metadata: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/enrich/chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, {
      chunks: [{ index, content, start, end, metadata }],
    })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Chunk enrichment failed ${res.status}: ${errText}`)
  }
  for await (const event of parseSse(res.body!)) {
    if (event.type === 'chunk_done') return event.chunk as Record<string, unknown>
    if (event.type === 'error') throw new Error(String(event.message ?? 'Chunk enrichment error'))
    if (event.type === 'cancelled') throw new DOMException('Chunk enrichment cancelled', 'AbortError')
  }
  throw new Error('Stream ended without a done event')
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isEnriched(chunk: Chunk): boolean {
  return !!(
    chunk.title ||
    chunk.summary ||
    chunk.context ||
    chunk.cleaned_chunk ||
    chunk.keywords?.length ||
    chunk.questions?.length
  )
}

function splitIntoBlocks(markdown: string): MdBlock[] {
  const lines = markdown.split('\n')
  const headingPositions: number[] = []

  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) headingPositions.push(i)
  }

  if (headingPositions.length === 0) {
    return [{ heading: '', content: markdown, startLine: 0, endLine: lines.length - 1 }]
  }

  // If there's content before the first heading, include it as block 0
  const starts = headingPositions[0] > 0 ? [0, ...headingPositions] : headingPositions

  return starts.map((startLine, i) => {
    const endLine = i + 1 < starts.length ? starts[i + 1] - 1 : lines.length - 1
    const content = lines.slice(startLine, endLine + 1).join('\n')
    const heading = /^#{1,6}\s/.test(lines[startLine]) ? lines[startLine] : ''
    return { heading, content, startLine, endLine }
  })
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MarkdownViewer({
  content, scale = 1.0, onScaleChange, padding = 20, onPaddingChange,
  scrollSyncEnabled = true, chunks, chunkVisualizationEnabled = false,
  onChunkEdit, onEnrichChunk, onDeleteChunk, onDeleteChunks, onMergeChunks,
  onSaveMarkdown, onSaveChunks, onDeleteMarkdown,
  savingMd, savingChunks, chunksReady,
  chunking = false,
  sectionEnrichment, chunkEnrichment,
}: Props) {
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [preEnrichContent, setPreEnrichContent] = useState<string | null>(null)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null)
  const [showReconvertConfirm, setShowReconvertConfirm] = useState(false)
  const [selectedChunks, setSelectedChunks] = useState<Set<number>>(new Set())
  const [enrichingChunks, setEnrichingChunks] = useState<Set<number>>(new Set())
  const [chunkEnrichErrors, setChunkEnrichErrors] = useState<Map<number, string>>(new Map())

  // Section picker
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerBlocks, setPickerBlocks] = useState<MdBlock[]>([])
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set())

  // Markdown enrichment modal
  const [mdEnrichOp, setMdEnrichOp] = useState<EnrichOp | null>(null)
  const mdEnrichAbortRef = useRef<AbortController | null>(null)

  // Chunk enrichment modal
  const [chunkEnrichOp, setChunkEnrichOp] = useState<EnrichOp | null>(null)
  const chunkEnrichAbortRef = useRef<AbortController | null>(null)

  // Clear selection when chunks change (e.g. re-chunked)
  useEffect(() => { setSelectedChunks(new Set()) }, [chunks])

  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()
  const savedScrollRatioRef = useRef<number>(0)

  useEffect(() => {
    setEditContent(content)
    setEditMode(false)
    setPreEnrichContent(null)
    setEnrichError(null)
  }, [content])

  useEffect(() => {
    if (chunkVisualizationEnabled && editMode) {
      setEditContent(content)
      setEditMode(false)
    }
  }, [chunkVisualizationEnabled])

  const saveScrollRatio = () => {
    if (!containerRef.current) return
    const el = containerRef.current
    const max = el.scrollHeight - el.clientHeight
    savedScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0
  }

  const restoreScrollRatio = () => {
    requestAnimationFrame(() => {
      if (!containerRef.current) return
      const el = containerRef.current
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = savedScrollRatioRef.current * max
    })
  }

  const handleEnterEdit = () => {
    saveScrollRatio()
    setEditMode(true)
  }

  useEffect(() => { if (editMode) restoreScrollRatio() }, [editMode])
  useEffect(() => { if (!editMode) restoreScrollRatio() }, [editMode])

  const handleSaveMd = async () => {
    saveScrollRatio()
    await onSaveMarkdown(editContent)
    setEditMode(false)
    setPreEnrichContent(null)
  }

  const handleCancelEdit = () => {
    saveScrollRatio()
    setEditContent(content)
    setEditMode(false)
    setPreEnrichContent(null)
    setEnrichError(null)
  }

  const handleReconvert = () => {
    setShowReconvertConfirm(false)
    onDeleteMarkdown()
  }

  // ── Markdown Enrichment ──────────────────────────────────────────────────

  const startMdEnrichment = useCallback(async (
    currentContent: string,
    blocks: MdBlock[],
    selectedIndices: number[],
  ) => {
    if (!sectionEnrichment) return

    const abortCtrl = new AbortController()
    mdEnrichAbortRef.current = abortCtrl

    setPreEnrichContent(currentContent)
    setMdEnrichOp({ title: 'Markdown Enrichment', detail: '', current: 0, total: selectedIndices.length })

    // Switch to edit mode so changes are visible as they arrive
    setEditMode(true)

    const enrichedBlocks = blocks.map(b => b.content)

    try {
      for (let i = 0; i < selectedIndices.length; i++) {
        if (abortCtrl.signal.aborted) break

        const blockIdx = selectedIndices[i]
        const block = blocks[blockIdx]
        const displayName = block.heading.replace(/^#{1,6}\s+/, '') || 'Introduction'

        setMdEnrichOp(prev => prev
          ? { ...prev, detail: `Block ${i + 1} of ${selectedIndices.length} — ${displayName}`, current: i + 1, errorMessage: undefined }
          : null
        )

        try {
          enrichedBlocks[blockIdx] = await apiEnrichMarkdown(
            sectionEnrichment,
            block.content,
            abortCtrl.signal,
            () => setMdEnrichOp(prev => prev ? { ...prev, errorMessage: CONNECTION_LOST_MSG } : null),
          )
          setEditContent(enrichedBlocks.join('\n'))
        } catch (err) {
          if ((err as DOMException).name === 'AbortError') break
          // Per-block error: keep original content, continue to next block
        }
      }
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') {
        setMdEnrichOp(prev => prev
          ? { ...prev, errorMessage: err instanceof Error ? err.message : 'Stream error' }
          : null
        )
        return
      }
    }

    setMdEnrichOp(null)
    mdEnrichAbortRef.current = null
  }, [sectionEnrichment])

  const handleInterruptMdEnrich = useCallback(() => {
    mdEnrichAbortRef.current?.abort()
    setMdEnrichOp(null)
  }, [])

  const handleEnrichSection = useCallback(() => {
    if (!sectionEnrichment?.model) {
      setEnrichError('Configure Section Enrichment (model) in Settings → Enrichment tab.')
      return
    }
    setEnrichError(null)
    const currentContent = editMode ? editContent : content
    const blocks = splitIntoBlocks(currentContent)

    if (blocks.length <= 1) {
      startMdEnrichment(currentContent, blocks, [0])
    } else {
      setPickerBlocks(blocks)
      setPickerSelected(new Set(blocks.map((_, i) => i)))
      setPickerOpen(true)
    }
  }, [sectionEnrichment, editMode, editContent, content, startMdEnrichment])

  const handleChunkSave = (index: number, content: string, metadataUpdates?: Partial<Chunk>) => {
    onChunkEdit(index, content)
    if (metadataUpdates) onEnrichChunk(index, metadataUpdates)
  }

  const handleUndoEnrich = () => {
    if (preEnrichContent !== null) {
      setEditContent(preEnrichContent)
      setPreEnrichContent(null)
    }
  }

  // ── Per-chunk Enrichment (single) ────────────────────────────────────────

  const handleEnrichChunk = async (chunkIndex: number) => {
    if (!chunkEnrichment?.model) {
      setChunkEnrichErrors(prev => new Map(prev).set(chunkIndex, 'Configure Chunk Enrichment settings (model) in Settings → Enrichment tab.'))
      return
    }
    setChunkEnrichErrors(prev => { const m = new Map(prev); m.delete(chunkIndex); return m })
    setEnrichingChunks(prev => new Set([...prev, chunkIndex]))

    const chunk = chunks![chunkIndex]
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

  // ── Bulk Chunk Enrichment ────────────────────────────────────────────────
  // Sends all selected chunks in a single SSE call. The backend processes them
  // sequentially and emits one chunk_done event per chunk, allowing the frontend
  // to update results incrementally without managing per-chunk loops.

  const handleInterruptChunkEnrich = useCallback(() => {
    chunkEnrichAbortRef.current?.abort()
    setChunkEnrichOp(null)
  }, [])

  const handleEnrichSelected = useCallback(async () => {
    if (!chunkEnrichment?.model) {
      setEnrichError('Configure Chunk Enrichment settings (model) in Settings → Enrichment tab.')
      return
    }
    if (!chunks || selectedChunks.size === 0) return

    const indices = Array.from(selectedChunks).sort((a, b) => a - b)
    const chunksToEnrich = indices.map(i => ({
      index: i,
      content: chunks[i].content,
      start: chunks[i].start ?? 0,
      end: chunks[i].end ?? 0,
      metadata: (chunks[i].metadata ?? {}) as Record<string, unknown>,
    }))

    const abortCtrl = new AbortController()
    chunkEnrichAbortRef.current = abortCtrl

    setChunkEnrichOp({ title: 'Chunk Enrichment', detail: '', current: 0, total: indices.length })

    try {
      const res = await fetch(`${API}/enrich/chunks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          chunks: chunksToEnrich,
          settings: {
            model: chunkEnrichment.model,
            base_url: chunkEnrichment.base_url ?? 'http://localhost:11434/v1',
            api_key: chunkEnrichment.api_key ?? 'ollama',
            temperature: chunkEnrichment.temperature ?? 0.3,
            user_prompt: chunkEnrichment.user_prompt,
          },
        }),
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
          const chunkIndex = chunk.index as number
          onEnrichChunk(chunkIndex, {
            cleaned_chunk: (chunk.cleaned_chunk as string) || chunks[chunkIndex]?.cleaned_chunk,
            title: (chunk.title as string) || chunks[chunkIndex]?.title,
            context: (chunk.context as string) || chunks[chunkIndex]?.context,
            summary: (chunk.summary as string) || chunks[chunkIndex]?.summary,
            keywords: Array.isArray(chunk.keywords) ? chunk.keywords as string[] : chunks[chunkIndex]?.keywords,
            questions: Array.isArray(chunk.questions) ? chunk.questions as string[] : chunks[chunkIndex]?.questions,
          })
          setChunkEnrichOp(prev => prev
            ? { ...prev, current: event.current as number, detail: `Enriched chunk ${chunkIndex + 1} of ${chunks.length}` }
            : null
          )
          // Yield to the event loop so React flushes state between events
          await new Promise<void>(r => setTimeout(r, 0))
        } else if (event.type === 'chunk_error') {
          // Per-chunk error: continue to next chunk (backend already does this too)
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
        // Keep modal open briefly so the user sees the error, then close
        await new Promise(r => setTimeout(r, 2000))
      }
    } finally {
      setChunkEnrichOp(null)
      chunkEnrichAbortRef.current = null
      setSelectedChunks(new Set())
    }
  }, [chunkEnrichment, chunks, selectedChunks, onEnrichChunk])

  const getColor = (i: number) => CHUNK_COLORS[i % CHUNK_COLORS.length]
  const getBorderColor = (i: number) => CHUNK_BORDER_COLORS[i % CHUNK_BORDER_COLORS.length]

  // ── Scroll sync ──────────────────────────────────────────────────────────
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingRef.current || !scrollSyncEnabled) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = e.target as HTMLDivElement
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) return
      const pct = Math.min(1, Math.max(0, el.scrollTop / maxScroll))
      savedScrollRatioRef.current = pct
      window.dispatchEvent(new CustomEvent('viewer-scroll', {
        detail: { source: 'markdown', percentage: pct }
      }))
    })
  }, [scrollSyncEnabled])

  const handleMouseUp = useCallback(() => {
    if (!scrollSyncEnabled || !containerRef.current) return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text) return
    const range = sel!.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const cRect = containerRef.current.getBoundingClientRect()
    const relY = (rect.top - cRect.top + containerRef.current.scrollTop) / containerRef.current.scrollHeight
    window.dispatchEvent(new CustomEvent('viewer-click-sync', {
      detail: { source: 'markdown', percentage: relY, selectedText: text }
    }))
  }, [scrollSyncEnabled])

  useEffect(() => {
    const onExtScroll = (e: Event) => {
      const ev = e as CustomEvent
      if (ev.detail.source !== 'pdf' || !containerRef.current || !scrollSyncEnabled) return
      isScrollingRef.current = true
      clearTimeout(scrollTimeoutRef.current)
      const el = containerRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) { isScrollingRef.current = false; return }
      el.scrollTo({ top: Math.round(Math.min(1, Math.max(0, ev.detail.percentage)) * maxScroll), behavior: 'instant' })
      savedScrollRatioRef.current = ev.detail.percentage
      scrollTimeoutRef.current = setTimeout(() => { isScrollingRef.current = false }, 50)
    }
    window.addEventListener('viewer-scroll', onExtScroll)
    return () => window.removeEventListener('viewer-scroll', onExtScroll)
  }, [scrollSyncEnabled])

  const toggleChunkSelection = (index: number) => {
    setSelectedChunks(prev => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const handleMergeSelected = () => {
    const indices = Array.from(selectedChunks).sort((a, b) => a - b)
    onMergeChunks(indices)
    setSelectedChunks(new Set())
  }

  const handleDeleteSelected = () => {
    onDeleteChunks(selectedChunks)
    setSelectedChunks(new Set())
  }

  // ── Render ───────────────────────────────────────────────────────────────
  const renderChunks = () => {
    if (!chunks?.length || !chunkVisualizationEnabled) {
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    }
    const allSelected = chunks.length > 0 && selectedChunks.size === chunks.length

    return (
      <>
        <div className="chunk-select-bar">
          <button
            className="chunk-select-btn"
            onClick={() => setSelectedChunks(allSelected ? new Set() : new Set(chunks.map((_, i) => i)))}
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          {selectedChunks.size > 0 && (
            <span className="chunk-select-count">{selectedChunks.size} / {chunks.length} selected</span>
          )}
        </div>

        {chunks.map((chunk, i) => {
          const isSelected = selectedChunks.has(i)
          const isEnriching = enrichingChunks.has(i)
          const enrichErrMsg = chunkEnrichErrors.get(i)
          const enriched = isEnriched(chunk)
          return (
            <div
              key={i}
              className={`chunk-block${isSelected ? ' chunk-block--selected' : ''}${enriched ? ' chunk-block--enriched' : ''}`}
              style={{
                backgroundColor: getColor(i),
                borderLeft: `4px solid ${getBorderColor(i)}`,
              }}
            >
              <div className="chunk-meta">
                <div className="chunk-meta-left">
                  <input
                    type="checkbox"
                    className="chunk-checkbox"
                    checked={isSelected}
                    onChange={() => toggleChunkSelection(i)}
                    title="Select chunk"
                  />
                  <span className="chunk-badge">
                    <span className="chunk-label">Chunk</span>
                    <span className="chunk-current">{i + 1}</span>
                    <span className="chunk-sep">/</span>
                    <span className="chunk-total">{chunks.length}</span>
                  </span>
                  {enriched && (
                    <span className="chunk-enriched-badge" title="This chunk has been enriched">★ Enriched</span>
                  )}
                </div>
                <div className="chunk-meta-actions">
                  <button
                    className="chunk-edit-btn"
                    onClick={() => setEditingChunkIndex(i)}
                    title="Edit chunk"
                    disabled={isEnriching}
                  >
                    ✏️ Edit
                  </button>
                  <button
                    className={`chunk-enrich-btn${isEnriching ? ' loading' : ''}`}
                    onClick={() => handleEnrichChunk(i)}
                    title="Enrich chunk with LLM"
                    disabled={isEnriching}
                  >
                    {isEnriching ? '⏳ Enriching…' : '✨ Enrich'}
                  </button>
                  <button
                    className="chunk-delete-btn"
                    onClick={() => onDeleteChunk(i)}
                    title="Delete chunk"
                    disabled={isEnriching}
                  >
                    🗑 Delete
                  </button>
                </div>
              </div>
              {enrichErrMsg && (
                <div className="chunk-enrich-error" title={enrichErrMsg}>
                  ⚠️ {enrichErrMsg}
                </div>
              )}
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.content}</ReactMarkdown>
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div className="md-viewer-wrapper">
      {/* Blocking progress modals */}
      <ProgressModal
        isOpen={!!mdEnrichOp}
        title={mdEnrichOp?.title ?? ''}
        detail={mdEnrichOp?.detail}
        current={mdEnrichOp?.current ?? 0}
        total={mdEnrichOp?.total ?? 0}
        onInterrupt={handleInterruptMdEnrich}
        errorMessage={mdEnrichOp?.errorMessage}
      />
      <ProgressModal
        isOpen={!!chunkEnrichOp}
        title={chunkEnrichOp?.title ?? ''}
        detail={chunkEnrichOp?.detail}
        current={chunkEnrichOp?.current ?? 0}
        total={chunkEnrichOp?.total ?? 0}
        onInterrupt={handleInterruptChunkEnrich}
        errorMessage={chunkEnrichOp?.errorMessage}
      />

      {/* Section picker */}
      {pickerOpen && (
        <div className="section-picker-overlay" onClick={() => setPickerOpen(false)}>
          <div className="section-picker" onClick={e => e.stopPropagation()}>
            <div className="section-picker-header">
              <h3>Select Sections to Enrich</h3>
              <button className="section-picker-close" onClick={() => setPickerOpen(false)}>✕</button>
            </div>
            <div className="section-picker-body">
              <div className="section-picker-actions">
                <button onClick={() => setPickerSelected(new Set(pickerBlocks.map((_, i) => i)))}>
                  Select all
                </button>
                <button onClick={() => setPickerSelected(new Set())}>
                  Deselect all
                </button>
              </div>
              <div className="section-picker-list">
                {pickerBlocks.map((block, i) => (
                  <label key={i} className="section-picker-item">
                    <input
                      type="checkbox"
                      checked={pickerSelected.has(i)}
                      onChange={() => {
                        setPickerSelected(prev => {
                          const next = new Set(prev)
                          next.has(i) ? next.delete(i) : next.add(i)
                          return next
                        })
                      }}
                    />
                    <span className="section-picker-label">
                      {block.heading.replace(/^#{1,6}\s+/, '') || 'Introduction'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="section-picker-footer">
              <button className="btn-secondary" onClick={() => setPickerOpen(false)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={pickerSelected.size === 0}
                onClick={() => {
                  const currentContent = editMode ? editContent : content
                  const indices = Array.from(pickerSelected).sort((a, b) => a - b)
                  setPickerOpen(false)
                  startMdEnrichment(currentContent, pickerBlocks, indices)
                }}
              >
                Enrich {pickerSelected.size} block{pickerSelected.size !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reconvert confirmation dialog */}
      {showReconvertConfirm && (
        <div className="reconvert-confirm-overlay" onClick={() => setShowReconvertConfirm(false)}>
          <div className="reconvert-confirm" onClick={e => e.stopPropagation()}>
            <p>This will delete the current Markdown so you can reconvert it. Continue?</p>
            <div className="reconvert-confirm-actions">
              <button className="btn-secondary" onClick={() => setShowReconvertConfirm(false)}>Cancel</button>
              <button className="btn-danger" onClick={handleReconvert}>Delete &amp; Reconvert</button>
            </div>
          </div>
        </div>
      )}

      {editingChunkIndex !== null && chunks?.[editingChunkIndex] && (
        <ChunkEditModal
          isOpen
          onClose={() => setEditingChunkIndex(null)}
          chunkIndex={editingChunkIndex}
          chunk={chunks[editingChunkIndex]}
          onSave={handleChunkSave}
          totalChunks={chunks.length}
        />
      )}

      {/* Controls bar */}
      <div className="md-controls">
        <div className="md-controls-left">
          <div className="md-zoom">
            <button onClick={() => onScaleChange(Math.max(0.5, scale - 0.1))} disabled={scale <= 0.5}>−</button>
            <span>{(scale * 100).toFixed(0)}%</span>
            <button onClick={() => onScaleChange(Math.min(3, scale + 0.1))} disabled={scale >= 3}>+</button>
          </div>

          <div className="padding-control">
            <label>Padding: {padding}px</label>
            <input type="range" min={0} max={100} value={padding} onChange={e => onPaddingChange(+e.target.value)} />
          </div>
        </div>

        <div className="md-controls-right">
          {/* Chunk visualization controls */}
          {chunkVisualizationEnabled && (
            <>
              {selectedChunks.size >= 2 && (
                <button
                  className="md-action-btn merge-chunks"
                  onClick={handleMergeSelected}
                  title="Merge selected chunks removing overlap"
                >
                  ⛓ Merge ({selectedChunks.size})
                </button>
              )}
              {selectedChunks.size >= 1 && (
                <button
                  className="md-action-btn enrich-chunks"
                  onClick={handleEnrichSelected}
                  title="Enrich selected chunks with LLM"
                >
                  ✨ Enrich ({selectedChunks.size})
                </button>
              )}
              {selectedChunks.size >= 1 && (
                <button
                  className="md-action-btn delete-chunks"
                  onClick={handleDeleteSelected}
                  title="Delete selected chunks"
                >
                  🗑 Delete ({selectedChunks.size})
                </button>
              )}
              <button
                className="md-action-btn save-chunks"
                onClick={onSaveChunks}
                disabled={!chunksReady || savingChunks || chunking}
                title="Save chunks to disk"
              >
                <span>{savingChunks ? '⏳' : '💾'}</span>
                {savingChunks ? 'Saving…' : chunking ? 'Chunking…' : 'Save'}
              </button>
            </>
          )}

          {/* Reconvert — hidden when chunk visualization is active */}
          {!chunkVisualizationEnabled && (
            <button
              className="md-action-btn reconvert"
              onClick={() => setShowReconvertConfirm(true)}
              title="Delete Markdown and reconvert"
            >
              <span>🔄</span> Reconvert
            </button>
          )}

          {/* Edit / Enrich / Save / Cancel — hidden when chunk visualization is active */}
          {!chunkVisualizationEnabled && (
            <div className="md-edit-actions">
              {!editMode ? (
                <>
                  <button className="md-action-btn edit" onClick={handleEnterEdit}>
                    ✏️ Edit
                  </button>
                  <button
                    className="md-action-btn enrich"
                    onClick={handleEnrichSection}
                    title="Enrich markdown with LLM"
                  >
                    ✨ Enrich
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="md-action-btn enrich"
                    onClick={handleEnrichSection}
                    title="Enrich markdown with LLM"
                  >
                    ✨ Enrich
                  </button>
                  {preEnrichContent !== null && (
                    <button className="md-action-btn undo-enrich" onClick={handleUndoEnrich} title="Undo enrichment">
                      ↩ Undo
                    </button>
                  )}
                  <button className="md-action-btn save-md" onClick={handleSaveMd} disabled={savingMd}>
                    {savingMd ? '⏳ Saving…' : '💾 Save'}
                  </button>
                  <button className="md-action-btn cancel" onClick={handleCancelEdit}>✕ Cancel</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Enrich error banner */}
      {enrichError && (
        <div className="enrich-error-banner">
          ⚠️ {enrichError}
          <button className="enrich-error-close" onClick={() => setEnrichError(null)}>✕</button>
        </div>
      )}

      {/* Viewer / editor */}
      <div
        className="md-viewer"
        ref={containerRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
        style={{ fontSize: `${(11 * scale).toFixed(1)}pt` }}
      >
        {content ? (
          editMode ? (
            <textarea
              className="md-raw-editor"
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              style={{ padding: `${padding}px` }}
              spellCheck={false}
            />
          ) : (
            <div className="markdown-content" style={{ padding: `${padding}px` }}>
              {renderChunks()}
            </div>
          )
        ) : (
          <div className="no-markdown"><p>No markdown content available</p></div>
        )}
      </div>
    </div>
  )
}
