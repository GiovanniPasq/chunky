import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DocumentSummary,
  DocumentSummaryResponse,
  EnrichmentSettings,
} from '../../types'
import {
  apiGenerateSummary,
  apiGetSummary,
  apiPutSummary,
  type SummaryGenerateProgress,
} from '../../services/apiService'
import './SummaryReviewModal.css'

interface Props {
  isOpen: boolean
  documentName: string | null
  filename: string | null
  settings: EnrichmentSettings
  onClose: () => void
  /**
   * Called when the user wants to proceed to the enrichment pipeline.
   *
   * - ``useSummary === true``  — the user reviewed (and possibly
   *   edited) the cached summary.  The modal has already persisted any
   *   edits via PUT; the caller should start the pipeline with the
   *   default ``use_summary: true`` request flag.
   * - ``useSummary === false`` — the user explicitly clicked Skip in
   *   the empty state.  No summary was generated or persisted; the
   *   caller should start the pipeline with ``use_summary: false`` so
   *   the backend bypasses any cached record for this run.
   */
  onConfirm: (useSummary: boolean) => void
}

type View = 'loading' | 'empty' | 'generating' | 'editing' | 'saving' | 'error'

const emptySummary = (): DocumentSummary => ({ topic: '', narrative: '' })

function summariesEqual(a: DocumentSummary, b: DocumentSummary): boolean {
  return a.topic === b.topic && a.narrative === b.narrative
}

export default function SummaryReviewModal({
  isOpen,
  documentName,
  filename,
  settings,
  onClose,
  onConfirm,
}: Props) {
  const [view, setView] = useState<View>('loading')
  // ``justGenerated`` distinguishes a freshly built summary from a cached
  // load.  Drives the "✓ Summary ready" banner so the user can see at a
  // glance that the fields below are the result of THIS run.
  const [justGenerated, setJustGenerated] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [lastFailedOp, setLastFailedOp] = useState<'load' | 'generate' | 'save'>('load')
  const [response, setResponse] = useState<DocumentSummaryResponse | null>(null)
  const [edited, setEdited] = useState<DocumentSummary>(emptySummary())
  const [progress, setProgress] = useState<SummaryGenerateProgress | null>(null)
  const generateAbortRef = useRef<AbortController | null>(null)
  const saveAbortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    if (!isOpen || !documentName || !filename) return
    let cancelled = false
    setView('loading')
    setErrorMessage('')
    setResponse(null)
    setEdited(emptySummary())
    setJustGenerated(false)
    apiGetSummary(filename, documentName)
      .then(res => {
        if (cancelled) return
        if (res === null) {
          setView('empty')
          return
        }
        setResponse(res)
        setEdited({
          topic: res.summary.topic ?? '',
          narrative: res.summary.narrative ?? '',
        })
        setView('editing')
      })
      .catch((err: Error) => {
        if (cancelled) return
        setLastFailedOp('load')
        setErrorMessage(err.message)
        setView('error')
      })
    return () => { cancelled = true }
  }, [isOpen, documentName, filename])

  useEffect(() => {
    if (!isOpen) {
      generateAbortRef.current?.abort()
      generateAbortRef.current = null
      saveAbortRef.current?.abort()
      saveAbortRef.current = null
    }
  }, [isOpen])

  // Failsafe transition.  In normal operation, ``runGenerate``'s
  // post-await setState block flips view to ``'editing'`` once the SSE
  // ``done`` event lands.  In edge cases — proxy/HMR weirdness or a
  // promise that resolves at an unlucky React-scheduling moment — that
  // transition has been observed to skip even though ``progress.stage``
  // is already ``'done'``.  Detect the stuck state and force the
  // transition by re-fetching the persisted summary directly.
  useEffect(() => {
    if (progress?.stage !== 'done' || view !== 'generating' || !documentName || !filename) return
    let cancelled = false
    apiGetSummary(filename, documentName)
      .then(res => {
        if (cancelled || !res) return
        setResponse(res)
        setEdited({
          topic: res.summary.topic ?? '',
          narrative: res.summary.narrative ?? '',
        })
        setJustGenerated(true)
        setView('editing')
      })
      .catch(() => { /* swallow — the main runGenerate path will surface errors */ })
    return () => { cancelled = true }
  }, [progress?.stage, view, documentName, filename])

  const runGenerate = useCallback(async (force: boolean) => {
    if (!documentName || !filename) return
    generateAbortRef.current?.abort()
    const ctrl = new AbortController()
    generateAbortRef.current = ctrl
    setView('generating')
    setErrorMessage('')
    setProgress({ stage: 'idle', totalPieces: 0, completedExtractions: 0 })
    try {
      const res = await apiGenerateSummary(
        filename,
        documentName,
        settings,
        force,
        p => {
          if (ctrl.signal.aborted) return
          setProgress({ ...p })
        },
        ctrl.signal,
      )
      if (!mountedRef.current || ctrl.signal.aborted) return
      const safeSummary = res?.summary ?? emptySummary()
      setResponse(res)
      setEdited({
        topic: safeSummary.topic ?? '',
        narrative: safeSummary.narrative ?? '',
      })
      setJustGenerated(true)
      setView('editing')
      requestAnimationFrame(() => { bodyRef.current?.scrollTo({ top: 0 }) })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (!mountedRef.current) return
      setLastFailedOp('generate')
      setErrorMessage(err instanceof Error ? err.message : 'Summary generation failed')
      setView('error')
    } finally {
      if (generateAbortRef.current === ctrl) generateAbortRef.current = null
      if (mountedRef.current) setProgress(null)
    }
  }, [documentName, filename, settings])

  const handleConfirm = useCallback(async () => {
    if (!documentName || !filename) return
    const original = response?.summary
    const isDirty = !original || !summariesEqual(original, edited)
    if (!isDirty) {
      onConfirm(true)
      onClose()
      return
    }
    saveAbortRef.current?.abort()
    const ctrl = new AbortController()
    saveAbortRef.current = ctrl
    setView('saving')
    try {
      await apiPutSummary(filename, documentName, edited, ctrl.signal)
      if (!mountedRef.current || ctrl.signal.aborted) return
      onConfirm(true)
      onClose()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (!mountedRef.current) return
      setLastFailedOp('save')
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save summary')
      setView('error')
    } finally {
      if (saveAbortRef.current === ctrl) saveAbortRef.current = null
    }
  }, [documentName, filename, response, edited, onConfirm, onClose])

  const handleRetry = useCallback(() => {
    if (!filename) {
      onClose()
      return
    }
    if (lastFailedOp === 'save') {
      handleConfirm()
    } else {
      runGenerate(false)
    }
  }, [filename, lastFailedOp, onClose, handleConfirm, runGenerate])

  const handleSkip = useCallback(() => {
    onConfirm(false)
    onClose()
  }, [onConfirm, onClose])

  if (!isOpen) return null

  const renderProgress = () => {
    const stageLabel: Record<SummaryGenerateProgress['stage'], string> = {
      idle: 'Starting…',
      cleanup: 'Cleaning markdown…',
      splitting: 'Splitting into sections…',
      extracting: progress
        ? `Extracting ${progress.completedExtractions}/${progress.totalPieces} sections`
        : 'Extracting…',
      reducing: 'Synthesising final summary…',
      done: 'Done.',
    }
    const total = progress?.totalPieces ?? 0
    const current = progress?.completedExtractions ?? 0
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
    return (
      <div className="summary-progress">
        <p className="summary-progress-stage">{progress ? stageLabel[progress.stage] : 'Working…'}</p>
        <div className="summary-progress-track">
          <div
            className={`summary-progress-fill${total === 0 ? ' summary-progress-fill--indeterminate' : ''}`}
            style={total > 0 ? { width: `${pct}%` } : undefined}
          />
        </div>
      </div>
    )
  }

  const status = response?.status
  // Footer modes:
  //  - "working": loading, generating, saving — show ONLY Cancel.
  //  - "review":  editing, empty, error — show Cancel + Regenerate + Confirm.
  const isWorking = view === 'loading' || view === 'generating' || view === 'saving'

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="summary-modal" role="dialog" aria-modal="true" aria-label="Document summary review">
        <div className="modal-header">
          <h2>Review document summary</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" ref={bodyRef}>
          {view === 'loading' && (
            <div className="summary-state-empty">Loading…</div>
          )}

          {view === 'empty' && (
            <div className="summary-state-empty">
              <p>No summary has been generated for this document yet.</p>
              <p className="label-hint">
                The summary describes what the document is about and is attached to every
                piece prompt during enrichment so the model has document-level context.
                It's cached per source document and reused across PDF converter variants.
                On very long documents generation can take several minutes.
              </p>
              <div className="summary-empty-actions">
                <button className="btn-primary" onClick={() => runGenerate(false)}>
                  ✨ Generate summary
                </button>
                <button
                  className="btn-secondary"
                  onClick={handleSkip}
                  title="Run enrichment now without building a document summary first"
                >
                  Skip — enrich without summary
                </button>
              </div>
            </div>
          )}

          {view === 'generating' && renderProgress()}

          {view === 'saving' && (
            <div className="summary-state-empty">Saving edits…</div>
          )}

          {view === 'error' && (
            <div className="summary-state-error">
              <p>⚠️ {errorMessage}</p>
              <button
                className="btn-secondary"
                onClick={handleRetry}
                title={
                  lastFailedOp === 'save'
                    ? 'Retry saving your edits'
                    : 'Reload the cached summary'
                }
              >
                {lastFailedOp === 'save' ? 'Retry save' : 'Try again'}
              </button>
            </div>
          )}

          {view === 'editing' && (
            <>
              {justGenerated && !edited.topic && !edited.narrative && (
                <div className="summary-warning-banner">
                  ⚠ The generated summary is empty.  Every section extraction returned
                  no content — most often this means the LLM endpoint is unreachable or
                  the configured model isn't installed.  Check the backend log for the
                  exact error, fix the model setting, and click <strong>Regenerate</strong>.
                </div>
              )}

              {justGenerated && (edited.topic || edited.narrative) && (
                <div className="summary-info-banner">
                  ✓ Summary ready — review the fields below, edit anything that looks wrong,
                  then click <strong>Confirm &amp; enrich</strong>.  Use Regenerate to rebuild
                  from scratch.
                </div>
              )}

              {status?.user_edited && !justGenerated && (
                <div className="summary-info-banner">
                  ✎ This summary has been manually edited.  It won't be auto-regenerated
                  unless you click Regenerate or replace the source document.
                </div>
              )}

              <div className="form-group">
                <label>Topic</label>
                <input
                  type="text"
                  value={edited.topic}
                  onChange={e => setEdited({ ...edited, topic: e.target.value })}
                  placeholder="What is this document about?"
                />
              </div>

              <div className="form-group">
                <label>Narrative</label>
                <textarea
                  value={edited.narrative}
                  onChange={e => setEdited({ ...edited, narrative: e.target.value })}
                  rows={10}
                  placeholder="A ~200-word coherent summary covering the whole document in source order."
                />
              </div>

              {status?.generated_at && (
                <p className="summary-meta">Generated {status.generated_at}</p>
              )}
            </>
          )}
        </div>

        <div className="modal-footer summary-modal-footer">
          {isWorking ? (
            <>
              <div className="modal-footer-spacer" />
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
            </>
          ) : (
            <>
              <button
                className="btn-secondary"
                onClick={() => runGenerate(true)}
                disabled={!filename}
                title="Discard the cached summary and rebuild it from scratch"
              >
                ↺ Regenerate
              </button>
              <div className="modal-footer-spacer" />
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="btn-primary"
                onClick={handleConfirm}
                disabled={view !== 'editing'}
                title="Save edits (if any) and start the enrichment pipeline"
              >
                Confirm &amp; enrich
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
