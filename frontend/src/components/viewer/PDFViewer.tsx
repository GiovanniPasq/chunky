import { useState, useEffect, useRef, useCallback, memo } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url'
import Toast from './Toast'
import './PDFViewer.css'

// Bundle the worker locally — no CDN dependency at runtime.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

interface Props {
  filename: string
  scale?: number
  onScaleChange: (s: number) => void
  scrollSyncEnabled?: boolean
  onToggleScrollSync?: () => void
}

// Pages to pre-render above and below the visible viewport.
const BUFFER = 2
// Height of the padding-bottom on .pdf-page (keeps the page-number label visible).
const PAGE_PADDING_BOTTOM = 40
// Flex gap between .pdf-page items (matches .pdf-container gap: 20px) plus margin-bottom: 3px.
const PAGE_GAP = 23
// Number of pages fetched in parallel when computing dimensions.
// Avoids flooding the PDF.js worker with all N requests at once while still
// being much faster than the fully sequential approach.
const DIM_BATCH = 20

/** Compute the inclusive [start, end] render window for the given scroll state. */
function computeRenderRange(
  dims: Array<{ width: number; height: number }>,
  scrollTop: number,
  viewHeight: number,
  numPages: number,
): [number, number] {
  if (dims.length === 0) return [0, Math.min(numPages - 1, BUFFER * 2)]

  // Container has 24px top padding; each page occupies (height + PAGE_PADDING_BOTTOM + PAGE_GAP).
  const CONTAINER_PAD = 24
  let cumH = CONTAINER_PAD
  let first = -1
  let last = -1

  for (let i = 0; i < dims.length; i++) {
    const pageTop = cumH
    const pageBottom = cumH + dims[i].height + PAGE_PADDING_BOTTOM

    if (first === -1 && pageBottom > scrollTop) first = i
    if (pageTop < scrollTop + viewHeight) last = i

    cumH += dims[i].height + PAGE_PADDING_BOTTOM + PAGE_GAP
  }

  if (first === -1) return [0, Math.min(numPages - 1, BUFFER * 2)]

  return [
    Math.max(0, first - BUFFER),
    Math.min(numPages - 1, last + BUFFER),
  ]
}

function PDFViewer({ filename, scale = 1.0, onScaleChange, scrollSyncEnabled = true, onToggleScrollSync }: Props) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  // Pre-computed CSS-pixel dimensions for every page at the current scale.
  // Used to size placeholder divs so scroll position is stable even for unrendered pages.
  const [pageDimensions, setPageDimensions] = useState<Array<{ width: number; height: number }>>([])
  // Inclusive [start, end] range of pages that should be rendered.
  const [renderRange, setRenderRange] = useState<[number, number]>([0, BUFFER * 2])

  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()

  // Cancel any pending animation frame and scroll timeout on unmount.
  // Also destroy the current PDF document to release its buffers.
  useEffect(() => {
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      if (scrollTimeoutRef.current !== undefined) clearTimeout(scrollTimeoutRef.current)
      setPdf(prev => { prev?.destroy(); return null })
    }
  }, [])

  // Tracks which pages have been rendered and at what scale.
  // Key: page index, Value: scale at which the page was rendered.
  const renderedAtScaleRef = useRef<Map<number, number>>(new Map())
  // Tracks which page indices currently have painted canvas content.
  // Allows the clear loop to be O(buffer) instead of O(numPages).
  const renderedPagesRef = useRef<Set<number>>(new Set())

  // ── Load PDF ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let incoming: pdfjsLib.PDFDocumentProxy | null = null

    // Destroy the previously loaded document to free its binary buffer and
    // decoded page objects. Without this, every file switch leaks several MB.
    setPdf(prev => { prev?.destroy(); return null })

    pdfjsLib.getDocument(`/api/pdf/${filename}`).promise
      .then(doc => {
        incoming = doc
        if (cancelled) { doc.destroy(); return }
        setPdf(doc)
        setNumPages(doc.numPages)
        setPageDimensions([])
        setRenderRange([0, Math.min(doc.numPages - 1, BUFFER * 2)])
        renderedAtScaleRef.current.clear()
        renderedPagesRef.current.clear()
      })
      .catch(() => {
        if (cancelled) return
        setToast(`Failed to load "${filename}"`)
      })
    return () => {
      cancelled = true
      // If the promise resolves after cleanup, destroy there (handled above).
      // If it hasn't resolved yet, destroy when it does via the incoming ref.
      if (incoming) { incoming.destroy() }
    }
  }, [filename])

  // ── Compute page dimensions (lightweight — no rendering) ──────
  useEffect(() => {
    if (!pdf || numPages === 0) return
    let cancelled = false

    const computeDims = async () => {
      const dims: Array<{ width: number; height: number }> = []
      // Fetch DIM_BATCH pages in parallel per iteration instead of one at a time.
      // Sequential getPage() on a 1000-page PDF means 1000 worker round-trips
      // before anything renders — several seconds of blank screen.
      for (let i = 0; i < numPages; i += DIM_BATCH) {
        if (cancelled) return
        const batch = await Promise.all(
          Array.from({ length: Math.min(DIM_BATCH, numPages - i) }, async (_, j) => {
            const page = await pdf.getPage(i + j + 1)
            const vp = page.getViewport({ scale })
            page.cleanup()
            return { width: vp.width, height: vp.height }
          })
        ).catch(() => null)
        if (cancelled || !batch) return
        dims.push(...batch)
      }
      if (!cancelled) {
        setPageDimensions(dims)
        // Reset render window to viewport position after scale/PDF change.
        if (containerRef.current) {
          const range = computeRenderRange(
            dims,
            containerRef.current.scrollTop,
            containerRef.current.clientHeight,
            numPages,
          )
          setRenderRange(range)
        }
        // Invalidate all previously rendered pages — scale has changed.
        renderedAtScaleRef.current.clear()
        renderedPagesRef.current.clear()
      }
    }

    computeDims()
    return () => { cancelled = true }
  }, [pdf, numPages, scale])

  // ── Render / unrender pages based on renderRange ──────────────
  useEffect(() => {
    if (!pdf || numPages === 0 || pageDimensions.length === 0) return

    let cancelled = false
    const renderTasks: pdfjsLib.RenderTask[] = []
    const [start, end] = renderRange
    const dpr = window.devicePixelRatio || 1

    const clearPage = (i: number) => {
      const canvas = canvasRefs.current[i]
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
        canvas.style.width = ''
        canvas.style.height = ''
      }
      const tl = textLayerRefs.current[i]
      if (tl) tl.innerHTML = ''
      renderedAtScaleRef.current.delete(i)
      renderedPagesRef.current.delete(i)
    }

    const renderPage = async (i: number) => {
      if (cancelled) return

      const page = await pdf.getPage(i + 1)
      if (cancelled) return

      const viewport = page.getViewport({ scale })
      const canvas = canvasRefs.current[i]
      if (!canvas || cancelled) return

      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      const ctx = canvas.getContext('2d')
      if (!ctx || cancelled) return
      ctx.scale(dpr, dpr)

      const task = page.render({ canvasContext: ctx, viewport })
      renderTasks.push(task)
      await task.promise.catch(() => {})
      if (cancelled) return

      renderedAtScaleRef.current.set(i, scale)
      renderedPagesRef.current.add(i)

      const tl = textLayerRefs.current[i]
      if (tl) {
        tl.innerHTML = ''
        tl.style.width = `${viewport.width}px`
        tl.style.height = `${viewport.height}px`
        // PDF.js requires --scale-factor on the text-layer container so that
        // its internal CSS can size text spans correctly.
        tl.style.setProperty('--scale-factor', String(viewport.scale))
        const tc = await page.getTextContent()
        if (!cancelled) {
          pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport, textDivs: [] })
        }
      }
    }

    const process = async () => {
      // Clear pages outside render window — O(rendered) instead of O(numPages).
      for (const i of renderedPagesRef.current) {
        if (i < start || i > end) clearPage(i)
      }

      // Render pages inside window that are not yet rendered at current scale.
      const toRender: Promise<void>[] = []
      for (let i = start; i <= end; i++) {
        if (renderedAtScaleRef.current.get(i) !== scale) {
          toRender.push(renderPage(i))
        }
      }
      await Promise.all(toRender)
    }

    process()

    return () => {
      cancelled = true
      for (const task of renderTasks) {
        try { task.cancel() } catch { /* already finished */ }
      }
    }
  }, [pdf, scale, numPages, renderRange, pageDimensions])

  // ── Scroll handler (sync + render range) ─────────────────────
  const updateRenderRange = useCallback(() => {
    if (!containerRef.current || pageDimensions.length === 0) return
    const container = containerRef.current
    const range = computeRenderRange(
      pageDimensions,
      container.scrollTop,
      container.clientHeight,
      numPages,
    )
    setRenderRange(prev => (prev[0] === range[0] && prev[1] === range[1] ? prev : range))
  }, [pageDimensions, numPages])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.target as HTMLDivElement
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      updateRenderRange()
      if (isScrollingRef.current || !scrollSyncEnabled) return
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) return
      window.dispatchEvent(new CustomEvent('viewer-scroll', {
        detail: { source: 'pdf', percentage: Math.min(1, Math.max(0, el.scrollTop / maxScroll)) }
      }))
    })
  }

  const handleMouseUp = () => {
    if (!scrollSyncEnabled || !containerRef.current) return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text || !sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    const cRect = containerRef.current.getBoundingClientRect()
    const relY = (rect.top - cRect.top + containerRef.current.scrollTop) / containerRef.current.scrollHeight
    window.dispatchEvent(new CustomEvent('viewer-click-sync', {
      detail: { source: 'pdf', percentage: relY, selectedText: text }
    }))
  }

  useEffect(() => {
    const onExtScroll = (e: Event) => {
      const ev = e as CustomEvent
      if (ev.detail.source !== 'markdown' || !containerRef.current || !scrollSyncEnabled) return
      isScrollingRef.current = true
      clearTimeout(scrollTimeoutRef.current)
      const el = containerRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) { isScrollingRef.current = false; return }
      el.scrollTo({ top: Math.round(Math.min(1, Math.max(0, ev.detail.percentage)) * maxScroll), behavior: 'instant' })
      scrollTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false
        updateRenderRange()
      }, 50)
    }
    window.addEventListener('viewer-scroll', onExtScroll)
    return () => window.removeEventListener('viewer-scroll', onExtScroll)
  }, [scrollSyncEnabled, updateRenderRange])

  return (
    <div className="pdf-viewer">
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      <div className="pdf-controls">
        <div className="pdf-zoom">
          <button onClick={() => onScaleChange(Math.max(0.5, scale - 0.1))} disabled={scale <= 0.5}>−</button>
          <span>{(scale * 100).toFixed(0)}%</span>
          <button onClick={() => onScaleChange(Math.min(3, scale + 0.1))} disabled={scale >= 3}>+</button>
        </div>

        <div className="pdf-controls-right">
          {onToggleScrollSync && (
            <button
              className={`pdf-sync-btn${scrollSyncEnabled ? ' active' : ''}`}
              onClick={onToggleScrollSync}
              title="Toggle scroll synchronization"
            >
              <span className="pdf-sync-icon">{scrollSyncEnabled ? '🔗' : '⛓️‍💥'}</span>
              <span className="pdf-sync-label">Sync</span>
              <span className={`pdf-sync-status${scrollSyncEnabled ? ' on' : ' off'}`}>
                {scrollSyncEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="pdf-container" ref={containerRef} onScroll={handleScroll} onMouseUp={handleMouseUp}>
        {Array.from({ length: numPages }, (_, i) => {
          const dims = pageDimensions[i]
          return (
            <div
              key={i}
              className="pdf-page"
              style={dims ? { minWidth: `${dims.width}px`, minHeight: `${dims.height + PAGE_PADDING_BOTTOM}px` } : undefined}
            >
              <canvas ref={el => { canvasRefs.current[i] = el }} />
              <div className="textLayer" ref={el => { textLayerRefs.current[i] = el }} />
              <div className="page-number">Page {i + 1} of {numPages}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default memo(PDFViewer)
