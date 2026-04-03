import { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Chunk, EnrichmentSettings } from '../../types'
import { useChunkEnrichment } from '../../hooks/useChunkEnrichment'
import ChunkEditModal from '../chunks/ChunkEditModal'
import ProgressModal from '../modals/ProgressModal'
import './MarkdownViewer.css'
import './ChunkViewer.css'

interface Props {
  chunks: Chunk[] | null
  /** Full document content — used to clear enrichment state on doc switch. */
  content: string
  chunksReady: boolean
  chunking: boolean
  savingChunks: boolean
  scrollSyncEnabled?: boolean
  chunkEnrichment?: EnrichmentSettings
  onEnrichChunk: (index: number, updates: Partial<Chunk>) => void
  onChunkEdit: (index: number, content: string) => void
  onDeleteChunk: (index: number) => void
  onDeleteChunks: (indices: Set<number>) => void
  onMergeChunks: (indices: number[]) => void
  onSaveChunks: () => void
  onEnrichSuccess?: (msg: string) => void
  onEnrichError?: (msg: string) => void
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

export default function ChunkViewer({
  chunks,
  content,
  chunksReady,
  chunking,
  savingChunks,
  scrollSyncEnabled = true,
  chunkEnrichment,
  onEnrichChunk,
  onChunkEdit,
  onDeleteChunk,
  onDeleteChunks,
  onMergeChunks,
  onSaveChunks,
  onEnrichSuccess,
  onEnrichError,
}: Props) {
  const [selectedChunks, setSelectedChunks] = useState<Set<number>>(new Set())
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null)
  const [enrichError, setEnrichError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()

  const {
    chunkEnrichOp,
    enrichingChunks,
    chunkEnrichErrors,
    handleInterruptChunkEnrich,
    handleEnrichChunk,
    handleEnrichSelected,
  } = useChunkEnrichment({
    chunkEnrichment,
    chunks,
    content,
    selectedChunks,
    onEnrichChunk,
    setEnrichError,
    setSelectedChunks,
    onSuccess: onEnrichSuccess,
    onError: onEnrichError,
  })

  // Clear selection when chunks change (edit, delete, merge, rechunk, doc switch).
  useEffect(() => {
    setSelectedChunks(new Set())
  }, [chunks])

  // ── Scroll sync ────────────────────────────────────────────────────────────

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingRef.current || !scrollSyncEnabled) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = e.target as HTMLDivElement
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) return
      const pct = Math.min(1, Math.max(0, el.scrollTop / maxScroll))
      window.dispatchEvent(new CustomEvent('viewer-scroll', {
        detail: { source: 'markdown', percentage: pct }
      }))
    })
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
      scrollTimeoutRef.current = setTimeout(() => { isScrollingRef.current = false }, 50)
    }
    window.addEventListener('viewer-scroll', onExtScroll)
    return () => window.removeEventListener('viewer-scroll', onExtScroll)
  }, [scrollSyncEnabled])

  // ── Helpers ────────────────────────────────────────────────────────────────

  const getColor = (i: number) => CHUNK_COLORS[i % CHUNK_COLORS.length]
  const getBorderColor = (i: number) => CHUNK_BORDER_COLORS[i % CHUNK_BORDER_COLORS.length]

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

  const handleChunkSave = (index: number, updatedContent: string, metadataUpdates?: Partial<Chunk>) => {
    onChunkEdit(index, updatedContent)
    if (metadataUpdates) onEnrichChunk(index, metadataUpdates)
  }

  return (
    <div className="md-viewer-wrapper">
      <ProgressModal
        isOpen={!!chunkEnrichOp}
        title={chunkEnrichOp?.title ?? ''}
        detail={chunkEnrichOp?.detail}
        current={chunkEnrichOp?.current ?? 0}
        total={chunkEnrichOp?.total ?? 0}
        onInterrupt={handleInterruptChunkEnrich}
        errorMessage={chunkEnrichOp?.errorMessage}
      />

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

      {/* Controls */}
      <div className="md-controls">
        <div className="md-controls-left">
          {chunks && (
            <>
              <button
                className="chunk-select-btn"
                onClick={() => setSelectedChunks(
                  chunks.length > 0 && selectedChunks.size === chunks.length
                    ? new Set()
                    : new Set(chunks.map((_, i) => i))
                )}
              >
                {chunks.length > 0 && selectedChunks.size === chunks.length ? 'Deselect all' : 'Select all'}
              </button>
              {selectedChunks.size > 0 && (
                <span className="chunk-select-count">{selectedChunks.size} / {chunks.length}</span>
              )}
              {selectedChunks.size >= 2 && (
                <button
                  className="md-action-btn merge-chunks"
                  onClick={handleMergeSelected}
                  title="Merge selected chunks removing overlap"
                >
                  ⛓ Merge
                </button>
              )}
              {selectedChunks.size > 0 && (
                <>
                  <button
                    className="md-action-btn enrich-chunks"
                    onClick={handleEnrichSelected}
                    title="Enrich selected chunks with LLM"
                  >
                    ✨ Enrich
                  </button>
                  <button
                    className="md-action-btn delete-chunks"
                    onClick={handleDeleteSelected}
                    title="Delete selected chunks"
                  >
                    🗑 Delete
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <div className="md-controls-right">
          <button
            className="md-action-btn save-chunks"
            onClick={onSaveChunks}
            disabled={!chunksReady || savingChunks || chunking}
            title="Save chunks to disk"
          >
            <span>{savingChunks ? '⏳' : '💾'}</span>
            {savingChunks ? 'Saving…' : chunking ? 'Chunking…' : 'Save Chunks'}
          </button>
        </div>
      </div>

      {/* Enrich error banner */}
      {enrichError && (
        <div className="enrich-error-banner">
          ⚠️ {enrichError}
          <button className="enrich-error-close" onClick={() => setEnrichError(null)}>✕</button>
        </div>
      )}

      {/* Content */}
      <div className="md-viewer" ref={containerRef} onScroll={handleScroll}>
        {!chunks ? (
          <div className="no-markdown">
            <p>{chunking ? 'Chunking document…' : 'No chunks available'}</p>
          </div>
        ) : (
          <div className="chunk-list">
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
          </div>
        )}
      </div>
    </div>
  )
}
