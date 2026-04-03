import { useState, useEffect, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import Toast from './Toast'
import './PDFViewer.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`

interface Props {
  filename: string
  scale?: number
  onScaleChange: (s: number) => void
  scrollSyncEnabled?: boolean
  onToggleScrollSync?: () => void
}

export default function PDFViewer({ filename, scale = 1.0, onScaleChange, scrollSyncEnabled = true, onToggleScrollSync }: Props) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()

  useEffect(() => {
    let cancelled = false
    pdfjsLib.getDocument(`/api/pdf/${filename}`).promise
      .then(doc => {
        if (cancelled) return
        setPdf(doc)
        setNumPages(doc.numPages)
      })
      .catch(e => {
        if (cancelled) return
        console.error('PDF load error:', e)
        setToast(`Failed to load "${filename}"`)
      })
    return () => { cancelled = true }
  }, [filename])

  // Render all pages whenever pdf or scale changes.
  // Cancels any in-flight render tasks from a previous run.
  useEffect(() => {
    if (!pdf || numPages === 0) return

    let cancelled = false
    const renderTasks: pdfjsLib.RenderTask[] = []
    const dpr = window.devicePixelRatio || 1

    const renderAll = async () => {
      for (let i = 0; i < numPages; i++) {
        if (cancelled) break

        const page = await pdf.getPage(i + 1)
        if (cancelled) break

        // getViewport respects the page's embedded rotation automatically.
        const viewport = page.getViewport({ scale })

        const canvas = canvasRefs.current[i]
        if (!canvas || cancelled) break

        // Physical pixels — sharp on HiDPI screens.
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        // CSS pixels — drives layout and matches text-layer coordinates.
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        const ctx = canvas.getContext('2d')
        if (!ctx || cancelled) break
        // Scale the context up by DPR so pdf.js renders at full resolution
        // without needing an extra transform parameter.
        ctx.scale(dpr, dpr)

        const task = page.render({ canvasContext: ctx, viewport })
        renderTasks.push(task)
        // Swallow AbortError thrown when a task is cancelled mid-render.
        await task.promise.catch(() => {})
        if (cancelled) break

        const tl = textLayerRefs.current[i]
        if (tl) {
          tl.innerHTML = ''
          // Match the CSS pixel dimensions of the canvas exactly so
          // pdf.js-computed span positions are correct.
          tl.style.width = `${viewport.width}px`
          tl.style.height = `${viewport.height}px`
          const tc = await page.getTextContent()
          if (!cancelled) {
            pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport, textDivs: [] })
          }
        }
      }
    }

    renderAll()

    return () => {
      cancelled = true
      for (const task of renderTasks) {
        try { task.cancel() } catch { /* already finished */ }
      }
    }
  }, [pdf, scale, numPages])

  // ── Scroll sync ──────────────────────────────────────────────
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingRef.current || !scrollSyncEnabled) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = e.target as HTMLDivElement
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
      scrollTimeoutRef.current = setTimeout(() => { isScrollingRef.current = false }, 50)
    }
    window.addEventListener('viewer-scroll', onExtScroll)
    return () => window.removeEventListener('viewer-scroll', onExtScroll)
  }, [scrollSyncEnabled])

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
        {Array.from({ length: numPages }, (_, i) => (
          <div key={i} className="pdf-page">
            <canvas ref={el => { canvasRefs.current[i] = el }} />
            <div className="textLayer" ref={el => { textLayerRefs.current[i] = el }} />
            <div className="page-number">Page {i + 1} of {numPages}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
