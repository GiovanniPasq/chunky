import { useRef, useEffect, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Chunk } from '../../types'
import ChunkEditModal from '../chunks/ChunkEditModal'
import Toast from './Toast'
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
  onSaveMarkdown: (content: string) => void
  savingMd: boolean
}

const CHUNK_COLORS = [
  'rgba(139, 69, 19, 0.12)', 'rgba(61, 107, 39, 0.12)', 'rgba(204, 34, 0, 0.09)',
  'rgba(180, 140, 60, 0.15)', 'rgba(30, 90, 140, 0.10)', 'rgba(210, 105, 30, 0.13)',
  'rgba(90, 50, 120, 0.09)', 'rgba(20, 110, 100, 0.11)', 'rgba(160, 60, 30, 0.12)',
  'rgba(60, 120, 60, 0.12)',
]

const CHUNK_BORDER_COLORS = [
  '#8B4513', '#3D6B27', '#CC2200',
  '#B48C3C', '#1E5A8C', '#D2691E',
  '#5A3278', '#146E64', '#A03C1E',
  '#3C783C',
]

export default function MarkdownViewer({
  content, scale = 1.0, onScaleChange, padding = 20, onPaddingChange,
  scrollSyncEnabled = true, chunks, chunkVisualizationEnabled = false,
  onChunkEdit, onSaveMarkdown, savingMd
}: Props) {
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [editingChunkIndex, setEditingChunkIndex] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()
  // Store scroll position as a ratio so it survives edit mode toggle
  const savedScrollRatioRef = useRef<number>(0)

  // Sync editContent when content prop changes (doc switch)
  useEffect(() => {
    setEditContent(content)
    setEditMode(false)
  }, [content])

  // Exit edit mode when chunk visualization is enabled
  useEffect(() => {
    if (chunkVisualizationEnabled && editMode) {
      setEditContent(content)
      setEditMode(false)
    }
  }, [chunkVisualizationEnabled])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  // ── Enter edit mode: save scroll ratio ──────────────────────────────────
  const handleEnterEdit = () => {
    if (containerRef.current) {
      const el = containerRef.current
      const max = el.scrollHeight - el.clientHeight
      savedScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0
    }
    setEditMode(true)
  }

  // ── After edit mode renders, restore scroll ──────────────────────────────
  useEffect(() => {
    if (!editMode || !containerRef.current) return
    const el = containerRef.current
    // Use rAF to wait for textarea render
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = savedScrollRatioRef.current * max
    })
  }, [editMode])

  // ── After leaving edit mode, restore scroll ──────────────────────────────
  useEffect(() => {
    if (editMode || !containerRef.current) return
    const el = containerRef.current
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight
      if (max > 0) el.scrollTop = savedScrollRatioRef.current * max
    })
  }, [editMode])

  const handleSaveMd = async () => {
    if (containerRef.current) {
      const el = containerRef.current
      const max = el.scrollHeight - el.clientHeight
      savedScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0
    }
    await onSaveMarkdown(editContent)
    setEditMode(false)
    showToast('✅ Markdown saved')
  }

  const handleCancelEdit = () => {
    if (containerRef.current) {
      const el = containerRef.current
      const max = el.scrollHeight - el.clientHeight
      savedScrollRatioRef.current = max > 0 ? el.scrollTop / max : 0
    }
    setEditContent(content)
    setEditMode(false)
  }

  const getColor = (i: number) => CHUNK_COLORS[i % CHUNK_COLORS.length]
  const getBorderColor = (i: number) => CHUNK_BORDER_COLORS[i % CHUNK_BORDER_COLORS.length]

  // ── Scroll sync ─────────────────────────────────────────────────────────
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingRef.current || !scrollSyncEnabled) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = e.target as HTMLDivElement
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) return
      const pct = Math.min(1, Math.max(0, el.scrollTop / maxScroll))
      // Update saved ratio too so edit mode toggle preserves position
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
      const target = Math.round(Math.min(1, Math.max(0, ev.detail.percentage)) * maxScroll)
      el.scrollTo({ top: target, behavior: 'instant' })
      savedScrollRatioRef.current = ev.detail.percentage
      scrollTimeoutRef.current = setTimeout(() => { isScrollingRef.current = false }, 50)
    }
    window.addEventListener('viewer-scroll', onExtScroll)
    return () => window.removeEventListener('viewer-scroll', onExtScroll)
  }, [scrollSyncEnabled])

  // ── Render ───────────────────────────────────────────────────────────────
  const renderChunks = () => {
    if (!chunks?.length || !chunkVisualizationEnabled) {
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    }
    return (
      <>
        {chunks.map((chunk, i) => (
          <div
            key={i}
            className="chunk-block"
            style={{
              backgroundColor: getColor(i),
              borderLeft: `4px solid ${getBorderColor(i)}`,
            }}
          >
            <div className="chunk-meta">
              <span className="chunk-badge">
                <span className="chunk-label">Chunk</span>
                <span className="chunk-current">{i + 1}</span>
                <span className="chunk-sep">/</span>
                <span className="chunk-total">{chunks.length}</span>
              </span>
              <button
                className="chunk-edit-btn"
                onClick={() => setEditingChunkIndex(i)}
                title="Edit chunk"
              >
                ✏️ Edit
              </button>
            </div>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{chunk.content}</ReactMarkdown>
          </div>
        ))}
      </>
    )
  }

  return (
    <div className="md-viewer-wrapper">
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      {editingChunkIndex !== null && chunks && (
        <ChunkEditModal
          isOpen
          onClose={() => setEditingChunkIndex(null)}
          chunkIndex={editingChunkIndex}
          chunkContent={chunks[editingChunkIndex]?.content ?? ''}
          onSave={onChunkEdit}
          totalChunks={chunks.length}
        />
      )}

      {/* Controls bar */}
      <div className="md-controls">
        <div className="md-zoom">
          <button onClick={() => onScaleChange(Math.max(0.5, scale - 0.1))} disabled={scale <= 0.5}>−</button>
          <span>{(scale * 100).toFixed(0)}%</span>
          <button onClick={() => onScaleChange(Math.min(3, scale + 0.1))} disabled={scale >= 3}>+</button>
        </div>

        <div className="padding-control">
          <label>Padding: {padding}px</label>
          <input type="range" min={0} max={100} value={padding} onChange={e => onPaddingChange(+e.target.value)} />
        </div>

        {/* Edit actions — hidden when chunk visualization is active */}
        {!chunkVisualizationEnabled && (
          <div className="md-edit-actions">
            {!editMode ? (
              <button className="md-edit-btn" onClick={handleEnterEdit} title="Edit markdown">
                ✏️ Edit
              </button>
            ) : (
              <>
                <button className="md-save-btn" onClick={handleSaveMd} disabled={savingMd}>
                  {savingMd ? '⏳ Saving…' : '💾 Save'}
                </button>
                <button className="md-cancel-btn" onClick={handleCancelEdit}>✕ Cancel</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Viewer / editor */}
      <div
        className="md-viewer"
        ref={containerRef}
        onScroll={handleScroll}
        onMouseUp={handleMouseUp}
        style={{ fontSize: `${(11 * scale).toFixed(1)}pt`, position: 'relative' }}
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