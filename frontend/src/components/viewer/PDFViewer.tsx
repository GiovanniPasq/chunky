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
}

export default function PDFViewer({ filename, scale = 1.0, onScaleChange, scrollSyncEnabled = true }: Props) {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()

  useEffect(() => { loadPDF() }, [filename])
  useEffect(() => { if (pdf) renderAllPages() }, [pdf, scale])

  const loadPDF = async () => {
    try {
      const doc = await pdfjsLib.getDocument(`/api/pdf/${filename}`).promise
      setPdf(doc)
      setNumPages(doc.numPages)
    } catch (e) { console.error(e) }
  }

  const renderAllPages = async () => {
    if (!pdf) return
    for (let p = 1; p <= numPages; p++) {
      const page = await pdf.getPage(p)
      const viewport = page.getViewport({ scale })
      const canvas = canvasRefs.current[p - 1]
      if (!canvas) continue
      canvas.height = viewport.height
      canvas.width = viewport.width
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise

      const tl = textLayerRefs.current[p - 1]
      if (tl) {
        tl.innerHTML = ''
        const tc = await page.getTextContent()
        pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport, textDivs: [] })
      }
    }
  }

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

  // Fixed: was `if (scrollSyncEnabled || ...)` which inverted the condition
  const handleMouseUp = () => {
    if (!scrollSyncEnabled || !containerRef.current) return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text) return
    const range = sel!.getRangeAt(0)
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
        <button onClick={() => onScaleChange(Math.max(0.5, scale - 0.1))} disabled={scale <= 0.5}>−</button>
        <span>{(scale * 100).toFixed(0)}%</span>
        <button onClick={() => onScaleChange(Math.min(3, scale + 0.1))} disabled={scale >= 3}>+</button>
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