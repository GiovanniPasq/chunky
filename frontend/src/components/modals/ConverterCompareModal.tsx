import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CapabilityConverter, ChunkSettings, ConverterType } from '../../types'
import { capabilityService } from '../../services/apiService'
import {
  cancelPreviewConversion,
  previewConversion,
  type ConversionPreviewResponse,
} from '../../services/documentsApi'
import ConfirmDialog from './ConfirmDialog'
import PDFViewer from '../viewer/PDFViewer'
import './ConverterCompareModal.css'

const FALLBACK_CONVERTERS: CapabilityConverter[] = [
  { name: 'pymupdf', label: 'PyMuPDF', description: '' },
  { name: 'docling', label: 'Docling', description: '' },
  { name: 'liteparse', label: 'LiteParse', description: '' },
  { name: 'markitdown', label: 'MarkItDown', description: '' },
  { name: 'vlm', label: 'VLM', description: '' },
  { name: 'cloud', label: 'Cloud', description: '' },
]

const PREVIEW_MAX_PAGES = 20
const PREFS_KEY = 'chunky:converter-compare:prefs'

type Side = 'left' | 'right'
type MarkdownViewMode = 'rendered' | 'raw'
type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; result: ConversionPreviewResponse }
  | { status: 'error'; message: string }

interface Props {
  isOpen: boolean
  filename: string
  settings: ChunkSettings
  onClose: () => void
}

interface ComparePrefs {
  leftConverter?: ConverterType
  rightConverter?: ConverterType
  showPdf?: boolean
  pdfScale?: number
  markdownViewMode?: MarkdownViewMode
}

function firstAlternative(converters: CapabilityConverter[], current: ConverterType): ConverterType {
  return converters.find(c => c.name !== current)?.name ?? current
}

function converterLabel(converters: CapabilityConverter[], name: ConverterType): string {
  return converters.find(c => c.name === name)?.label ?? name
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err || 'Preview failed')
}

function loadPrefs(): ComparePrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ComparePrefs
    return {
      leftConverter: typeof parsed.leftConverter === 'string' ? parsed.leftConverter : undefined,
      rightConverter: typeof parsed.rightConverter === 'string' ? parsed.rightConverter : undefined,
      showPdf: typeof parsed.showPdf === 'boolean' ? parsed.showPdf : undefined,
      pdfScale: typeof parsed.pdfScale === 'number' ? parsed.pdfScale : undefined,
      markdownViewMode: parsed.markdownViewMode === 'raw' ? 'raw' : parsed.markdownViewMode === 'rendered' ? 'rendered' : undefined,
    }
  } catch {
    return {}
  }
}

function savePrefs(prefs: ComparePrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage can be unavailable in private windows; preferences are optional.
  }
}

function clampPdfScale(scale: number | undefined): number {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 0.7
  return Math.min(2, Math.max(0.5, Math.round(scale * 10) / 10))
}

export default function ConverterCompareModal({ isOpen, filename, settings, onClose }: Props) {
  const [converters, setConverters] = useState<CapabilityConverter[]>(FALLBACK_CONVERTERS)
  const [leftConverter, setLeftConverter] = useState<ConverterType>(settings.converter)
  const [rightConverter, setRightConverter] = useState<ConverterType>(
    firstAlternative(FALLBACK_CONVERTERS, settings.converter),
  )
  const [startDraft, setStartDraft] = useState('1')
  const [endDraft, setEndDraft] = useState('1')
  const [leftState, setLeftState] = useState<PreviewState>({ status: 'idle' })
  const [rightState, setRightState] = useState<PreviewState>({ status: 'idle' })
  const [formError, setFormError] = useState<string | null>(null)
  const [copiedSide, setCopiedSide] = useState<Side | null>(null)
  const [showPdf, setShowPdf] = useState(false)
  const [pdfScale, setPdfScale] = useState(0.7)
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>('rendered')
  const [prefsReady, setPrefsReady] = useState(false)
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false)
  const [cancellingClose, setCancellingClose] = useState(false)
  const controllersRef = useRef<AbortController[]>([])
  const previewIdsRef = useRef<string[]>([])
  const runIdRef = useRef(0)
  const leftConverterRef = useRef<ConverterType>(leftConverter)
  const rightConverterRef = useRef<ConverterType>(rightConverter)

  leftConverterRef.current = leftConverter
  rightConverterRef.current = rightConverter

  const loading = leftState.status === 'loading' || rightState.status === 'loading'

  const makePreviewId = (side: Side) => {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return `compare-${side}-${random}`
  }

  const abortRunning = async () => {
    const previewIds = previewIdsRef.current
    previewIdsRef.current = []
    await Promise.allSettled(previewIds.map(cancelPreviewConversion))
    controllersRef.current.forEach(controller => controller.abort())
    controllersRef.current = []
    runIdRef.current += 1
  }

  const abortRunningBestEffort = () => {
    previewIdsRef.current.forEach(id => { void cancelPreviewConversion(id).catch(() => undefined) })
    previewIdsRef.current = []
    controllersRef.current.forEach(controller => controller.abort())
    controllersRef.current = []
    runIdRef.current += 1
  }

  useEffect(() => {
    if (!isOpen) {
      abortRunningBestEffort()
      setPrefsReady(false)
      return
    }

    const prefs = loadPrefs()
    const left = prefs.leftConverter ?? settings.converter
    setLeftConverter(left)
    setRightConverter(prefs.rightConverter ?? firstAlternative(converters, left))
    setStartDraft('1')
    setEndDraft('1')
      setLeftState({ status: 'idle' })
      setRightState({ status: 'idle' })
      setFormError(null)
      setCopiedSide(null)
      setConfirmCloseOpen(false)
      setCancellingClose(false)
      setShowPdf(prefs.showPdf ?? false)
      setPdfScale(clampPdfScale(prefs.pdfScale))
      setMarkdownViewMode(prefs.markdownViewMode ?? 'rendered')
    setPrefsReady(false)
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    const sanitiseAgainst = (available: CapabilityConverter[]) => {
      setConverters(available)
      const nextLeft = available.some(c => c.name === leftConverterRef.current)
        ? leftConverterRef.current
        : (available[0]?.name ?? settings.converter)
      const nextRight = available.some(c => c.name === rightConverterRef.current)
        ? rightConverterRef.current
        : firstAlternative(available, nextLeft)
      setLeftConverter(nextLeft)
      setRightConverter(nextRight)
      setPrefsReady(true)
    }

    capabilityService.get()
      .then(data => {
        if (cancelled) return
        const available = data.converters.length > 0 ? data.converters : FALLBACK_CONVERTERS
        sanitiseAgainst(available)
      })
      .catch(() => {
        if (!cancelled) sanitiseAgainst(FALLBACK_CONVERTERS)
      })

    return () => { cancelled = true }
  }, [isOpen, settings.converter])

  useEffect(() => {
    if (!isOpen || !prefsReady) return
    savePrefs({
      leftConverter,
      rightConverter,
      showPdf,
      pdfScale,
      markdownViewMode,
    })
  }, [isOpen, prefsReady, leftConverter, rightConverter, showPdf, pdfScale, markdownViewMode])

  useEffect(() => {
    if (!loading) setConfirmCloseOpen(false)
  }, [loading])

  const range = useMemo(() => {
    const start = Number(startDraft)
    const end = Number(endDraft)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      return { ok: false as const, message: 'Pages must be positive whole numbers.' }
    }
    if (end < start) {
      return { ok: false as const, message: 'End page must be greater than or equal to start page.' }
    }
    if (end - start + 1 > PREVIEW_MAX_PAGES) {
      return { ok: false as const, message: `Preview is limited to ${PREVIEW_MAX_PAGES} pages.` }
    }
    return { ok: true as const, start, end }
  }, [startDraft, endDraft])

  const runSide = async (
    side: Side,
    converter: ConverterType,
    start: number,
    end: number,
    runId: number,
    controller: AbortController,
    previewId: string,
  ) => {
    const setState = side === 'left' ? setLeftState : setRightState
    setState({ status: 'loading' })
    try {
      const result = await previewConversion({
        filename,
        converter,
        start_page: start,
        end_page: end,
        preview_id: previewId,
        vlm: converter === 'vlm' ? { ...settings.vlm, use_checkpoint: false } : undefined,
        cloud: converter === 'cloud' ? settings.cloud : undefined,
      }, controller.signal)
      if (runIdRef.current === runId) setState({ status: 'success', result })
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return
      if (runIdRef.current === runId) setState({ status: 'error', message: errorMessage(err) })
    }
  }

  const handlePreview = () => {
    if (!prefsReady) return
    if (!range.ok) {
      setFormError(range.message)
      return
    }
    setFormError(null)
    abortRunningBestEffort()
    const runId = runIdRef.current
    const leftController = new AbortController()
    const rightController = new AbortController()
    const leftPreviewId = makePreviewId('left')
    const rightPreviewId = makePreviewId('right')
    controllersRef.current = [leftController, rightController]
    previewIdsRef.current = [leftPreviewId, rightPreviewId]
    void runSide('left', leftConverter, range.start, range.end, runId, leftController, leftPreviewId)
    void runSide('right', rightConverter, range.start, range.end, runId, rightController, rightPreviewId)
  }

  const handleCopy = async (side: Side, content: string) => {
    await navigator.clipboard.writeText(content)
    setCopiedSide(side)
    window.setTimeout(() => setCopiedSide(prev => prev === side ? null : prev), 1200)
  }

  const closeImmediately = async () => {
    setCancellingClose(true)
    await abortRunning()
    setCancellingClose(false)
    onClose()
  }

  const requestClose = () => {
    if (loading || cancellingClose) {
      setConfirmCloseOpen(true)
      return
    }
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
      <div className="compare-overlay" onClick={requestClose}>
        <div className="compare-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Compare converters">
          <div className="compare-header">
            <div>
              <h3>Compare converters</h3>
              <p>{filename} · selected pages only, no files are saved</p>
            </div>
            <button className="compare-close" onClick={requestClose} aria-label="Close">✕</button>
          </div>

          <div className="compare-controls">
            <label>
              Left
              <select value={leftConverter} onChange={e => setLeftConverter(e.target.value)}>
                {converters.map(c => <option key={c.name} value={c.name}>{c.label}</option>)}
              </select>
            </label>
            <label>
              Right
              <select value={rightConverter} onChange={e => setRightConverter(e.target.value)}>
                {converters.map(c => <option key={c.name} value={c.name}>{c.label}</option>)}
              </select>
            </label>
            <label>
              Start page
              <input value={startDraft} onChange={e => setStartDraft(e.target.value)} inputMode="numeric" />
            </label>
            <label>
              End page
              <input value={endDraft} onChange={e => setEndDraft(e.target.value)} inputMode="numeric" />
            </label>
            <label className="compare-checkbox">
              <input
                type="checkbox"
                checked={showPdf}
                onChange={e => setShowPdf(e.target.checked)}
              />
              Show PDF
            </label>
            <div className="compare-view-toggle" role="group" aria-label="Markdown preview mode">
              <button
                className={markdownViewMode === 'rendered' ? 'active' : ''}
                onClick={() => setMarkdownViewMode('rendered')}
                type="button"
              >
                Rendered
              </button>
              <button
                className={markdownViewMode === 'raw' ? 'active' : ''}
                onClick={() => setMarkdownViewMode('raw')}
                type="button"
              >
                Raw
              </button>
            </div>
            <button className="compare-preview-btn" onClick={handlePreview} disabled={loading || !prefsReady}>
              {loading ? 'Previewing…' : prefsReady ? 'Preview' : 'Loading…'}
            </button>
          </div>

          {formError && <div className="compare-form-error">{formError}</div>}

          <div className={`compare-grid${showPdf ? ' with-pdf' : ''}`}>
            {showPdf && (
              <section className="compare-pane compare-pdf-pane">
                <div className="compare-pane-header">
                  <strong>PDF</strong>
                  <div className="compare-pdf-zoom">
                    <button onClick={() => setPdfScale(v => Math.max(0.5, Math.round((v - 0.1) * 10) / 10))}>−</button>
                    <span>{Math.round(pdfScale * 100)}%</span>
                    <button onClick={() => setPdfScale(v => Math.min(2, Math.round((v + 0.1) * 10) / 10))}>+</button>
                  </div>
                </div>
                <PDFViewer
                  filename={filename}
                  scale={pdfScale}
                  scrollSyncEnabled={false}
                />
              </section>
            )}
            <PreviewPane
              title={converterLabel(converters, leftConverter)}
              state={leftState}
              viewMode={markdownViewMode}
              copied={copiedSide === 'left'}
              onCopy={content => handleCopy('left', content)}
            />
            <PreviewPane
              title={converterLabel(converters, rightConverter)}
              state={rightState}
              viewMode={markdownViewMode}
              copied={copiedSide === 'right'}
              onCopy={content => handleCopy('right', content)}
            />
          </div>
        </div>
      </div>
      <ConfirmDialog
        isOpen={confirmCloseOpen}
        onDismiss={() => { if (!cancellingClose) setConfirmCloseOpen(false) }}
        actions={[
          {
            label: 'Keep previewing',
            onClick: () => setConfirmCloseOpen(false),
            variant: 'secondary',
            disabled: cancellingClose,
          },
          {
            label: cancellingClose ? 'Interrupting…' : 'Close and interrupt',
            onClick: () => { void closeImmediately() },
            variant: 'danger',
            disabled: cancellingClose,
          },
        ]}
      >
        Closing this modal will interrupt the converter preview. Continue?
      </ConfirmDialog>
    </>
  )
}

function PreviewPane({
  title,
  state,
  viewMode,
  copied,
  onCopy,
}: {
  title: string
  state: PreviewState
  viewMode: MarkdownViewMode
  copied: boolean
  onCopy: (content: string) => void
}) {
  const content = state.status === 'success' ? state.result.md_content : ''

  return (
    <section className="compare-pane">
      <div className="compare-pane-header">
        <strong>{title}</strong>
        <button
          className="compare-copy-btn"
          disabled={!content}
          onClick={() => onCopy(content)}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {state.status === 'idle' && (
        <div className="compare-empty">Choose pages and click Preview.</div>
      )}
      {state.status === 'loading' && (
        <div className="compare-empty">Running converter…</div>
      )}
      {state.status === 'error' && (
        <div className="compare-error">{state.message}</div>
      )}
      {state.status === 'success' && (
        viewMode === 'raw'
          ? <pre className="compare-output raw">{state.result.md_content || '(empty output)'}</pre>
          : (
            <div className="compare-output rendered">
              {state.result.md_content
                ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.result.md_content}</ReactMarkdown>
                : <p>(empty output)</p>}
            </div>
          )
      )}
    </section>
  )
}
