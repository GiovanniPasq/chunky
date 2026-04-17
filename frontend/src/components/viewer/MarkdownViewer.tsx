import { useRef, useEffect, useState, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EnrichmentSettings } from '../../types'
import { useMarkdownEnrichment } from '../../hooks/useMarkdownEnrichment'
import { useScrollSync } from '../../hooks/useScrollSync'
import { VIEWER_PAGE_SYNC } from '../../utils/viewerEvents'
import ProgressModal from '../modals/ProgressModal'
import './MarkdownViewer.css'

interface Props {
  content: string
  scale?: number
  onScaleChange: (s: number) => void
  padding?: number
  onPaddingChange: (p: number) => void
  scrollSyncEnabled?: boolean
  onSaveMarkdown: (content: string) => Promise<void>
  onDeleteMarkdown: () => void
  savingMd: boolean
  sectionEnrichment?: EnrichmentSettings
  onEnrichSuccess?: (msg: string) => void
  onEnrichError?: (msg: string) => void
}

// ── Page-marker helpers ─────────────────────────────────────────────────────

// Split content at page-marker comments into per-page sections.
// This avoids false positives from `---` horizontal rules inside page content.
function splitAtPageMarkers(md: string): Array<{ page: number; content: string }> | null {
  const parts = md.split(/<!--\s*page-marker:(\d+)\s*-->/)
  // parts = [before_first_marker, '1', content1, '2', content2, ...]
  if (parts.length < 3) return null
  const sections: Array<{ page: number; content: string }> = []
  for (let i = 1; i < parts.length; i += 2) {
    const page = parseInt(parts[i], 10)
    // Strip the trailing `\n\n---\n\n` page-separator (added by the backend between pages)
    const content = (parts[i + 1] ?? '').replace(/\n\n---\n\n$/, '').trim()
    sections.push({ page, content })
  }
  return sections.length > 0 ? sections : null
}

// ── Lazy section splitting ──────────────────────────────────────────────────

// Split markdown at blank-line boundaries into groups of ~targetSize chars.
// Splitting at \n\n guarantees we never cut inside a block element (table row,
// code fence, list item) so each section is always valid standalone markdown.
function splitIntoLazySections(md: string, targetSize = 2500): string[] {
  const blocks = md.split(/\n\n+/)
  const sections: string[] = []
  let current = ''
  for (const block of blocks) {
    if (current.length > 0 && current.length + block.length + 2 > targetSize) {
      sections.push(current)
      current = block
    } else {
      current = current.length > 0 ? `${current}\n\n${block}` : block
    }
  }
  if (current.length > 0) sections.push(current)
  return sections.length > 0 ? sections : [md]
}

// Renders a height-matched placeholder until the section scrolls within 300 px
// of the viewport, then replaces it with the parsed ReactMarkdown output.
// React.memo prevents re-parsing when the parent re-renders with the same content.
const LazySection = memo(function LazySection({
  content: sectionContent,
  estimatedHeight,
}: {
  content: string
  estimatedHeight: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (visible) return <ReactMarkdown remarkPlugins={[remarkGfm]}>{sectionContent}</ReactMarkdown>
  return <div ref={ref} style={{ minHeight: estimatedHeight }} />
})

// ── Component ──────────────────────────────────────────────────────────────

function MarkdownViewer({
  content, scale = 1.0, onScaleChange, padding = 20, onPaddingChange,
  scrollSyncEnabled = true,
  onSaveMarkdown, onDeleteMarkdown,
  savingMd,
  sectionEnrichment,
  onEnrichSuccess, onEnrichError,
}: Props) {
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [showReconvertConfirm, setShowReconvertConfirm] = useState(false)

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
    onSuccess: onEnrichSuccess,
    onError: onEnrichError,
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const restoreRafRef = useRef<number>()
  const savedScrollRatioRef = useRef<number>(0)

  // Pre-compute lazy sections once per content change.
  // For VLM output (page markers present) each page is further split into
  // ~2 500-char buckets. For plain output the whole string is bucketed directly.
  // Either way, only sections near the viewport are ever parsed by ReactMarkdown.
  const lazyContent = useMemo(() => {
    const paged = splitAtPageMarkers(content)
    if (paged) {
      return {
        type: 'paged' as const,
        pages: paged.map(ps => ({
          page: ps.page,
          sections: splitIntoLazySections(ps.content),
        })),
      }
    }
    return { type: 'single' as const, sections: splitIntoLazySections(content) }
  }, [content])

  const hasPageSync = lazyContent.type === 'paged'

  // Listen for page-sync events from the PDF viewer.
  useEffect(() => {
    if (!hasPageSync) return
    const scrollToPage = (pageNum: number) => {
      if (!containerRef.current) return
      const anchor = document.getElementById(`md-page-anchor-${pageNum}`)
      if (!anchor) {
        if (pageNum === 1) containerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      const containerRect = containerRef.current.getBoundingClientRect()
      const anchorRect = anchor.getBoundingClientRect()
      const scrollTop = containerRef.current.scrollTop + (anchorRect.top - containerRect.top) - 8
      containerRef.current.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' })
    }
    const handler = (e: Event) => {
      const ev = e as CustomEvent
      if (ev.detail.source !== 'pdf') return
      scrollToPage(ev.detail.page as number)
    }
    window.addEventListener(VIEWER_PAGE_SYNC, handler)
    return () => window.removeEventListener(VIEWER_PAGE_SYNC, handler)
  }, [hasPageSync])

  useEffect(() => {
    setEditContent(content)
    setEditMode(false)
    setEnrichError(null)
  }, [content])

  // ── Scroll ratio save/restore ──────────────────────────────────────────────

  const restoreScrollRatio = (toEditMode: boolean) => {
    if (restoreRafRef.current !== undefined) cancelAnimationFrame(restoreRafRef.current)
    restoreRafRef.current = requestAnimationFrame(() => {
      restoreRafRef.current = undefined
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
    restoreScrollRatio(editMode)
    return () => { if (restoreRafRef.current !== undefined) cancelAnimationFrame(restoreRafRef.current) }
  }, [editMode])

  // Cancel any in-flight RAF on unmount, regardless of editMode state.
  useEffect(() => {
    return () => { if (restoreRafRef.current !== undefined) cancelAnimationFrame(restoreRafRef.current) }
  }, [])

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


  // ── Scroll sync ────────────────────────────────────────────────────────────

  const { handleScroll } = useScrollSync(
    scrollSyncEnabled ?? false,
    'markdown',
    'pdf',
    containerRef,
    (pct) => { savedScrollRatioRef.current = pct },
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="md-viewer-wrapper">
      {/* Section enrichment progress modal */}
      <ProgressModal
        isOpen={!!mdEnrichOp}
        title={mdEnrichOp?.title ?? ''}
        detail={mdEnrichOp?.detail}
        current={mdEnrichOp?.current ?? 0}
        total={mdEnrichOp?.total ?? 0}
        onInterrupt={handleInterruptMdEnrich}
        errorMessage={mdEnrichOp?.errorMessage}
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
          <button
            className="md-action-btn reconvert"
            onClick={() => setShowReconvertConfirm(true)}
            title="Delete Markdown and reconvert"
          >
            <span>🔄</span> Reconvert
          </button>

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
              {lazyContent.type === 'paged' ? (
                lazyContent.pages.map(({ page, sections }) => (
                  <div key={page}>
                    {page === 1
                      ? <div id="md-page-anchor-1" style={{ height: 0 }} />
                      : (
                        <div className="md-page-break" id={`md-page-anchor-${page}`}>
                          <hr />
                          <button
                            className="md-page-label"
                            title={`Jump PDF to page ${page}`}
                            onClick={() => window.dispatchEvent(new CustomEvent(VIEWER_PAGE_SYNC, {
                              detail: { source: 'markdown', page },
                            }))}
                          >
                            Page {page}
                          </button>
                        </div>
                      )
                    }
                    {sections.map((section, i) => (
                      <LazySection
                        key={i}
                        content={section}
                        estimatedHeight={Math.max(80, section.length * 0.3)}
                      />
                    ))}
                  </div>
                ))
              ) : (
                lazyContent.sections.map((section, i) => (
                  <LazySection
                    key={i}
                    content={section}
                    estimatedHeight={Math.max(80, section.length * 0.3)}
                  />
                ))
              )}
            </div>
          )
        ) : (
          <div className="no-markdown"><p>No markdown content available</p></div>
        )}
      </div>
    </div>
  )
}

export default memo(MarkdownViewer)
