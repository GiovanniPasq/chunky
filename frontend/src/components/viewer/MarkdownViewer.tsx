import { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Chunk, EnrichmentSettings } from '../../types'
import { useMarkdownEnrichment } from '../../hooks/useMarkdownEnrichment'
import { useChunkEnrichment } from '../../hooks/useChunkEnrichment'
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
  onToggleChunkViz?: () => void
  onChunkEdit: (index: number, content: string) => void
  onEnrichChunk: (index: number, updates: Partial<Chunk>) => void
  onDeleteChunk: (index: number) => void
  onDeleteChunks: (indices: Set<number>) => void
  onMergeChunks: (indices: number[]) => void
  onSaveMarkdown: (content: string) => Promise<void>
  onSaveChunks: () => void
  onDeleteMarkdown: () => void
  savingMd: boolean
  savingChunks: boolean
  chunksReady: boolean
  chunking?: boolean
  sectionEnrichment?: EnrichmentSettings
  chunkEnrichment?: EnrichmentSettings
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

// ── Page-marker helpers ─────────────────────────────────────────────────────

// Return a fresh RegExp instance each time to avoid shared lastIndex state.
const pageMarkerRe = () => /<!--\s*page-marker:(\d+)\s*-->/g

function extractPageMarkers(md: string): Array<{ page: number; offset: number }> {
  const markers: Array<{ page: number; offset: number }> = []
  let m: RegExpExecArray | null
  const re = pageMarkerRe()
  while ((m = re.exec(md)) !== null) {
    markers.push({ page: parseInt(m[1], 10), offset: m.index })
  }
  return markers
}

function stripPageMarkers(md: string): string {
  return md.replace(pageMarkerRe(), '')
}

// ── Component ──────────────────────────────────────────────────────────────

export default function MarkdownViewer({
  content, scale = 1.0, onScaleChange, padding = 20, onPaddingChange,
  scrollSyncEnabled = true, chunks, chunkVisualizationEnabled = false, onToggleChunkViz,
  onChunkEdit, onEnrichChunk, onDeleteChunk, onDeleteChunks, onMergeChunks,
  onSaveMarkdown, onSaveChunks, onDeleteMarkdown,
  savingMd, savingChunks, chunksReady,
  chunking = false,
  sectionEnrichment, chunkEnrichment,
}: Props) {
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null)
  const [showReconvertConfirm, setShowReconvertConfirm] = useState(false)
  const [selectedChunks, setSelectedChunks] = useState<Set<number>>(new Set())

  // ── Section (Markdown) enrichment ─────────────────────────────────────────
  const {
    mdEnrichOp,
    preEnrichContent,
    pickerOpen,
    pickerBlocks,
    pickerSelected,
    setPickerOpen,
    setPickerSelected,
    handleInterruptMdEnrich,
    handleEnrichSection,
    handleUndoEnrich,
    clearPreEnrich,
    confirmPicker,
  } = useMarkdownEnrichment({
    sectionEnrichment,
    editMode,
    editContent,
    content,
    setEditContent,
    setEditMode,
    setEnrichError,
  })

  // ── Chunk enrichment ───────────────────────────────────────────────────────
  const {
    chunkEnrichOp,
    enrichingChunks,
    chunkEnrichErrors,
    handleInterruptChunkEnrich,
    handleEnrichChunk,
    handleEnrichSelected,
  } = useChunkEnrichment({
    chunkEnrichment,
    chunks: chunks ?? null,
    content,
    selectedChunks,
    onEnrichChunk,
    setEnrichError,
    setSelectedChunks,
  })

  // Clear chunk selection whenever the chunk array changes (edit, delete, merge,
  // rechunk, or document switch).
  useEffect(() => {
    setSelectedChunks(new Set())
  }, [chunks])

  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()
  const savedScrollRatioRef = useRef<number>(0)

  // Counter used by the custom <hr> renderer to assign page numbers.
  // Reset to 0 before each render pass so page numbers stay consistent.
  const hrCounterRef = useRef(0)

  // Whether the current content has VLM page markers.
  const pageMarkers = useMemo(() => extractPageMarkers(content), [content])
  const hasPageSync = pageMarkers.length > 0

  // Clean content (markers stripped) for rendering.
  const renderContent = useMemo(() => hasPageSync ? stripPageMarkers(content) : content, [content, hasPageSync])

  // Scroll MarkdownViewer to the anchor element for a given page number.
  const scrollToPage = useCallback((pageNum: number) => {
    const anchor = document.getElementById(`md-page-anchor-${pageNum}`)
    if (!anchor || !containerRef.current) return
    const containerRect = containerRef.current.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    const scrollTop = containerRef.current.scrollTop + (anchorRect.top - containerRect.top) - 8
    containerRef.current.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
  }, [])

  // Listen for page-sync events from the PDF viewer.
  useEffect(() => {
    if (!hasPageSync) return
    const handler = (e: Event) => {
      const ev = e as CustomEvent
      if (ev.detail.source !== 'pdf') return
      scrollToPage(ev.detail.page as number)
    }
    window.addEventListener('viewer-page-sync', handler)
    return () => window.removeEventListener('viewer-page-sync', handler)
  }, [hasPageSync, scrollToPage])

  useEffect(() => {
    setEditContent(content)
    setEditMode(false)
    setEnrichError(null)
  }, [content])

  useEffect(() => {
    if (chunkVisualizationEnabled && editMode) {
      setEditContent(content)
      setEditMode(false)
    }
  }, [chunkVisualizationEnabled])

  // ── Scroll ratio save/restore ──────────────────────────────────────────────

  const restoreScrollRatio = (toEditMode: boolean) => {
    requestAnimationFrame(() => {
      const el: HTMLElement | null = toEditMode
        ? (textareaRef.current ?? containerRef.current)
        : containerRef.current
      if (!el) return
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = savedScrollRatioRef.current * max
    })
  }

  const handleEnterEdit = () => {
    const el = containerRef.current
    if (el) {
      const max = el.scrollHeight - el.clientHeight
      savedScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0
    }
    setEditMode(true)
  }

  useEffect(() => {
    if (!editMode) return
    restoreScrollRatio(true)
  }, [editMode])

  useEffect(() => {
    if (editMode) return
    restoreScrollRatio(false)
  }, [editMode])

  const handleSaveMd = async () => {
    const ta = textareaRef.current
    if (ta) {
      const max = ta.scrollHeight - ta.clientHeight
      savedScrollRatioRef.current = max > 0 ? ta.scrollTop / max : 0
    }
    await onSaveMarkdown(editContent)
    setEditMode(false)
    clearPreEnrich()
  }

  const handleCancelEdit = () => {
    const ta = textareaRef.current
    if (ta) {
      const max = ta.scrollHeight - ta.clientHeight
      savedScrollRatioRef.current = max > 0 ? ta.scrollTop / max : 0
    }
    setEditContent(content)
    setEditMode(false)
    clearPreEnrich()
    setEnrichError(null)
  }

  const handleReconvert = () => {
    setShowReconvertConfirm(false)
    onDeleteMarkdown()
  }

  const handleChunkSave = (index: number, content: string, metadataUpdates?: Partial<Chunk>) => {
    onChunkEdit(index, content)
    if (metadataUpdates) onEnrichChunk(index, metadataUpdates)
  }

  const getColor = (i: number) => CHUNK_COLORS[i % CHUNK_COLORS.length]
  const getBorderColor = (i: number) => CHUNK_BORDER_COLORS[i % CHUNK_BORDER_COLORS.length]

  // ── Scroll sync ────────────────────────────────────────────────────────────

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

  // ── Chunk selection ────────────────────────────────────────────────────────

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

  // ── Custom <hr> renderer — adds "Page N" labels for VLM output ─────────────

  const PageBreakHr = useCallback(() => {
    hrCounterRef.current += 1
    const nextPage = hrCounterRef.current + 1
    return (
      <div className="md-page-break" id={`md-page-anchor-${nextPage}`}>
        <hr />
        <button
          className="md-page-label"
          title={`Jump PDF to page ${nextPage}`}
          onClick={() => window.dispatchEvent(new CustomEvent('viewer-page-sync', {
            detail: { source: 'markdown', page: nextPage },
          }))}
        >
          Page {nextPage}
        </button>
      </div>
    )
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  const renderChunks = () => {
    hrCounterRef.current = 0
    const mdComponents = hasPageSync ? { hr: PageBreakHr } : undefined

    if (!chunks?.length || !chunkVisualizationEnabled) {
      return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {renderContent}
        </ReactMarkdown>
      )
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
                        const next = new Set(pickerSelected)
                        next.has(i) ? next.delete(i) : next.add(i)
                        setPickerSelected(next)
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
                onClick={confirmPicker}
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

      {/* Primary controls bar */}
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
          {/* Chunk Visualization toggle */}
          {onToggleChunkViz && (
            <button
              className={`md-chunk-viz-btn${chunkVisualizationEnabled ? ' active' : ''}`}
              onClick={onToggleChunkViz}
              title="Toggle chunk visualization"
            >
              <span>{chunkVisualizationEnabled ? '🎨' : '📄'}</span>
              <span className="md-chunk-viz-label">Chunks</span>
              <span className={`md-chunk-viz-status${chunkVisualizationEnabled ? ' on' : ' off'}`}>
                {chunkVisualizationEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
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

          {/* Save Chunks — always visible when chunk viz is on */}
          {chunkVisualizationEnabled && (
            <button
              className="md-action-btn save-chunks"
              onClick={onSaveChunks}
              disabled={!chunksReady || savingChunks || chunking}
              title="Save chunks to disk"
            >
              <span>{savingChunks ? '⏳' : '💾'}</span>
              {savingChunks ? 'Saving…' : chunking ? 'Chunking…' : 'Save Chunks'}
            </button>
          )}
        </div>
      </div>

      {/* Chunk action row — visible only when one or more chunks are selected */}
      {chunkVisualizationEnabled && selectedChunks.size > 0 && (
        <div className="md-chunk-actions-row">
          <span className="md-chunk-actions-label">
            {selectedChunks.size} chunk{selectedChunks.size !== 1 ? 's' : ''} selected
          </span>
          {selectedChunks.size >= 2 && (
            <button
              className="md-action-btn merge-chunks"
              onClick={handleMergeSelected}
              title="Merge selected chunks removing overlap"
            >
              ⛓ Merge
            </button>
          )}
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
        </div>
      )}

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
              ref={textareaRef}
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
