import { useState, useEffect, useRef, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Chunk, EnrichmentSettings } from '../../types'
import { useChunkEnrichment } from '../../hooks/useChunkEnrichment'
import { useScrollSync } from '../../hooks/useScrollSync'
import { isChunkEnriched } from '../../utils/chunkUtils'
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

// ── Lazy rendering ─────────────────────────────────────────────────────────
// Renders a height-matched placeholder until the chunk scrolls within 300px
// of the viewport, then swaps in the real content and disconnects the observer.
// This keeps frame times low for documents with 100+ chunks.

function LazyChunk({ children, estimatedHeight }: { children: ReactNode; estimatedHeight: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (visible) return <>{children}</>
  return <div ref={ref} style={{ minHeight: estimatedHeight }} />
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


type PendingOp =
  | { type: 'delete-single'; index: number }
  | { type: 'delete-bulk'; indices: Set<number> }
  | { type: 'merge'; indices: number[] }

function ChunkViewer({
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
  const [pendingOp, setPendingOp] = useState<PendingOp | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const prevChunkCountRef = useRef<number | null>(null)

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

  // Clear selection only on structural changes (delete, merge, rechunk, doc switch).
  // Enrichment updates change chunk content but not length — those must NOT clear
  // the selection or the user sees checkboxes flash off during bulk enrichment.
  useEffect(() => {
    const newCount = chunks?.length ?? null
    if (newCount !== prevChunkCountRef.current) {
      prevChunkCountRef.current = newCount
      setSelectedChunks(new Set())
    }
  }, [chunks])

  // ── Scroll sync ────────────────────────────────────────────────────────────

  const { handleScroll } = useScrollSync(
    scrollSyncEnabled,
    'markdown',
    'pdf',
    containerRef,
  )

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isEnrichmentActive = enrichingChunks.size > 0 || chunkEnrichOp !== null

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
    if (isEnrichmentActive) { setPendingOp({ type: 'merge', indices }); return }
    onMergeChunks(indices)
    setSelectedChunks(new Set())
  }

  const handleDeleteSelected = () => {
    if (isEnrichmentActive) { setPendingOp({ type: 'delete-bulk', indices: new Set(selectedChunks) }); return }
    onDeleteChunks(selectedChunks)
    setSelectedChunks(new Set())
  }

  const handleDeleteChunk = (index: number) => {
    if (isEnrichmentActive) { setPendingOp({ type: 'delete-single', index }); return }
    onDeleteChunk(index)
  }

  const handleConfirmInterrupt = () => {
    handleInterruptChunkEnrich()
    const op = pendingOp
    setPendingOp(null)
    if (!op) return
    if (op.type === 'delete-single') {
      onDeleteChunk(op.index)
    } else if (op.type === 'delete-bulk') {
      onDeleteChunks(op.indices)
      setSelectedChunks(new Set())
    } else if (op.type === 'merge') {
      onMergeChunks(op.indices)
      setSelectedChunks(new Set())
    }
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

      {pendingOp && (
        <div className="confirm-overlay">
          <div className="confirm-card" role="dialog" aria-modal="true">
            <div className="confirm-card-header">
              <h3 className="confirm-title">Enrichment in progress</h3>
            </div>
            <div className="confirm-card-body">
              <p className="confirm-message">
                An enrichment operation is currently running. Proceeding will interrupt it.
                Do you want to continue?
              </p>
            </div>
            <div className="confirm-card-footer">
              <button className="confirm-btn confirm-btn--cancel" onClick={() => setPendingOp(null)}>
                Cancel
              </button>
              <button className="confirm-btn confirm-btn--ok" onClick={handleConfirmInterrupt}>
                OK
              </button>
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
              const enriched = isChunkEnriched(chunk)
              // Estimate height from content length so the placeholder approximates
              // the real height and minimises scroll-position jumps on reveal.
              const estimatedHeight = Math.max(100, Math.min(800, chunk.content.length * 0.4))
              return (
                <LazyChunk key={chunk.index} estimatedHeight={estimatedHeight}>
                <div
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
                        onClick={() => handleDeleteChunk(i)}
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
                  <div className="markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.content}</ReactMarkdown>
                  </div>
                </div>
                </LazyChunk>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(ChunkViewer)
