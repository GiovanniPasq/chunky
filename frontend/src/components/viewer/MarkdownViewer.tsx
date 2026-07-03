import { useRef, useEffect, useState, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { EnrichmentSettings } from '../../types'
import { useScrollSync } from '../../hooks/useScrollSync'
import { VIEWER_PAGE_SYNC } from '../../utils/viewerEvents'
import { LAZY_OBSERVER_MARGIN, LAZY_SECTION_TARGET_CHARS } from '../../config'
import { downloadTextFile, replaceExtension, safeDownloadFilename } from '../../utils/download'
import { splitMarkdownSections } from '../../utils/markdownSections'
import ProgressModal from '../modals/ProgressModal'
import EnrichDiffModal from '../modals/EnrichDiffModal'
import SummaryReviewModal from '../modals/SummaryReviewModal'
import { useMarkdownEnrichment } from '../../hooks/useMarkdownEnrichment'
import './MarkdownViewer.css'

interface Props {
  content: string
  documentName: string
  /** Display scale (managed and rendered by the parent — see App.tsx). */
  scale?: number
  /** Padding around the rendered Markdown (managed by the parent). */
  padding?: number
  scrollSyncEnabled?: boolean
  onSaveMarkdown: (content: string) => Promise<void>
  onDeleteMarkdown: () => void
  /** Triggers PDF→Markdown conversion with the converter currently selected
   *  in Settings. User-triggered conversions replace that converter's
   *  existing Markdown output atomically. */
  onConvert: () => void
  /** User-facing label for the active converter (shown on the Convert
   *  button so the user knows which method will run). */
  converterLabel: string
  /** Canonical converter id ("vlm", "pymupdf", …) — used to gate
   *  VLM-specific affordances like the "Retry failed pages" action. */
  activeConverter: string
  converting: boolean
  savingMd: boolean
  sectionEnrichment?: EnrichmentSettings
  onEnrichSuccess?: (msg: string) => void
  onEnrichError?: (msg: string) => void
  /** Reports whether the raw editor contains unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void
  /** Filename of the markdown variant currently displayed.  Required by
   *  the pipeline enrichment endpoint — the backend loads the source
   *  content from disk so the checkpoint key stays stable across
   *  requests. */
  mdFilename?: string
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
      { rootMargin: LAZY_OBSERVER_MARGIN },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (visible) return <ReactMarkdown remarkPlugins={[remarkGfm]}>{sectionContent}</ReactMarkdown>
  return <div ref={ref} style={{ minHeight: estimatedHeight }} />
})

// ── Component ──────────────────────────────────────────────────────────────

function MarkdownViewer({
  content, documentName, scale = 1.0, padding = 20,
  scrollSyncEnabled = true,
  onSaveMarkdown, onDeleteMarkdown,
  onConvert, converterLabel, activeConverter, converting,
  savingMd,
  sectionEnrichment,
  onEnrichSuccess, onEnrichError,
  onDirtyChange,
  mdFilename,
}: Props) {
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const {
    enrichError,
    setEnrichError,
    summaryModalOpen,
    closeSummaryModal,
    pipelineProgress,
    pipelineResult,
    pipelineSaving,
    pipelineCurrent,
    pipelineTotal,
    pipelineDetail,
    handleOpenEnrich,
    handleConfirmSummary,
    handleInterruptPipeline,
    handleAcceptPipeline,
    handleRejectPipeline,
  } = useMarkdownEnrichment({
    documentName,
    mdFilename,
    sectionEnrichment,
    onSaveMarkdown,
    onEnrichSuccess,
    onEnrichError,
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const restoreRafRef = useRef<number | undefined>(undefined)
  const savedScrollRatioRef = useRef<number>(0)
  const markdownDirty = editMode && editContent !== content

  useEffect(() => {
    onDirtyChange?.(markdownDirty)
    return () => onDirtyChange?.(false)
  }, [markdownDirty, onDirtyChange])

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
          sections: splitMarkdownSections(ps.content, LAZY_SECTION_TARGET_CHARS),
        })),
      }
    }
    return {
      type: 'single' as const,
      sections: splitMarkdownSections(content, LAZY_SECTION_TARGET_CHARS),
    }
  }, [content])

  const hasPageSync = lazyContent.type === 'paged'

  // ── Failed-page detection ────────────────────────────────────────────────
  // The VLM converter emits ``<!-- page N failed: <error> -->`` placeholders
  // for pages that could not be transcribed.  Surface these to the user
  // with a banner + a retry button. Checkpoint reuse follows the current
  // VLM setting.
  const failedPages = useMemo<number[]>(() => {
    const re = /<!--\s*page\s+(\d+)\s+failed:/g
    const out: number[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const n = parseInt(m[1], 10)
      if (!Number.isNaN(n)) out.push(n)
    }
    return Array.from(new Set(out)).sort((a, b) => a - b)
  }, [content])

  const formatFailedPages = (pages: number[]): string => {
    if (pages.length <= 8) return pages.join(', ')
    return `${pages.slice(0, 6).join(', ')}, … (+${pages.length - 6} more)`
  }

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

  const handleSaveMd = async () => {
    const ta = textareaRef.current
    if (ta) {
      const max = ta.scrollHeight - ta.clientHeight
      savedScrollRatioRef.current = max > 0 ? ta.scrollTop / max : 0
    }
    try {
      await onSaveMarkdown(editContent)
      setEnrichError(null)
      setEditMode(false)
    } catch {
      setEnrichError('Failed to save Markdown')
    }
  }

  const handleCancelEdit = () => {
    const ta = textareaRef.current
    if (ta) {
      const max = ta.scrollHeight - ta.clientHeight
      savedScrollRatioRef.current = max > 0 ? ta.scrollTop / max : 0
    }
    setEditContent(content)
    setEditMode(false)
    setEnrichError(null)
  }

  const handleConfirmDelete = () => {
    setShowDeleteConfirm(false)
    onDeleteMarkdown()
  }

  const handleDownloadMarkdown = () => {
    const filename = safeDownloadFilename(
      mdFilename ?? replaceExtension(documentName, '.md'),
      'document.md',
    )
    downloadTextFile(filename, editMode ? editContent : content, 'text/markdown;charset=utf-8')
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
      {/* Enrichment progress modal — driven by the pipeline endpoint
          (deterministic cleanup + structure-aware split + per-piece LLM with
          rolling context). */}
      <ProgressModal
        isOpen={pipelineProgress !== null}
        title="Enrichment"
        detail={pipelineDetail}
        current={pipelineCurrent}
        total={pipelineTotal}
        onInterrupt={handleInterruptPipeline}
      />

      {/* Diff preview — shown after the pipeline completes; the user
          must explicitly accept before the enriched content is written
          to disk. */}
      <EnrichDiffModal
        isOpen={pipelineResult !== null}
        original={editMode ? editContent : content}
        result={pipelineResult}
        onAccept={handleAcceptPipeline}
        onReject={handleRejectPipeline}
        onClose={handleRejectPipeline}
        saving={pipelineSaving}
      />

      {/* Summary Review modal — the first step of the Enrich flow.  Lets
          the user inspect, edit, or regenerate the per-document summary
          before any piece-correction LLM calls run.  Confirming starts
          the enrichment pipeline; cancelling closes without enriching. */}
      <SummaryReviewModal
        isOpen={summaryModalOpen}
        documentName={documentName}
        filename={mdFilename ?? null}
        settings={sectionEnrichment ?? {}}
        onClose={closeSummaryModal}
        onConfirm={handleConfirmSummary}
      />

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="reconvert-confirm-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="reconvert-confirm" onClick={e => e.stopPropagation()}>
            <p>Delete the currently displayed Markdown variant? Other variants of this document stay intact.</p>
            <div className="reconvert-confirm-actions">
              <button className="btn-secondary" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button className="btn-danger" onClick={handleConfirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Primary controls bar — actions only.  Zoom + padding live in the
          panel header (see App.tsx) so this row never overflows. */}
      <div className="md-controls">
        <div className="md-controls-right">
          <button
            className="md-action-btn convert-now"
            onClick={onConvert}
            disabled={converting || editMode}
            title={editMode
              ? 'Save or cancel Markdown edits before reconverting'
              : `Convert this PDF with ${converterLabel}`}
          >
            <span>✨</span> Convert with {converterLabel}
          </button>
          <button
            className="md-action-btn delete-md"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={editMode}
            title={editMode
              ? 'Save or cancel Markdown edits before deleting this variant'
              : 'Delete this Markdown variant'}
          >
            <span>🗑</span> Delete
          </button>
          <button
            className="md-action-btn download"
            onClick={handleDownloadMarkdown}
            disabled={!content && !editContent}
            title={editMode
              ? 'Download the edited Markdown currently shown'
              : 'Download this Markdown variant'}
          >
            <span>⬇</span> Export
          </button>

          <div className="md-edit-actions">
            {!editMode ? (
              <>
                <button className="md-action-btn edit" onClick={handleEnterEdit}>
                  ✏️ Edit
                </button>
                <button
                  className="md-action-btn enrich"
                  onClick={handleOpenEnrich}
                  title="Review the document summary, then clean and LLM-correct the markdown piece-by-piece. Preview the diff before saving."
                  disabled={pipelineProgress !== null || pipelineResult !== null || summaryModalOpen}
                >
                  ✨ Enrich
                </button>
              </>
            ) : (
              <>
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

      {/* VLM partial-conversion banner — surfaces failed pages and offers
          a one-click retry. Re-running follows the checkpoint choice in
          Settings. The retry button is gated on the active
          converter being VLM, otherwise clicking it would silently run a
          different converter (which couldn't reuse the VLM checkpoint).*/}
      {failedPages.length > 0 && (() => {
        const canRetry = activeConverter === 'vlm'
        return (
          <div className="failed-pages-banner">
            <span>
              ⚠️ {failedPages.length} page{failedPages.length !== 1 ? 's' : ''} failed transcription:
              {' '}<strong>{formatFailedPages(failedPages)}</strong>
            </span>
            <button
              className="failed-pages-retry"
              onClick={onConvert}
              disabled={converting || editMode || !canRetry}
              title={canRetry
                ? editMode
                  ? 'Save or cancel Markdown edits before retrying conversion.'
                  : 'Re-run VLM conversion. Checkpoint reuse follows the current Settings choice.'
                : 'Switch the converter to VLM in Settings to retry failed pages.'}
            >
              ↻ Retry failed pages
            </button>
          </div>
        )
      })()}

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
