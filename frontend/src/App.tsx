import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Sidebar from './components/layout/Sidebar'
import MarkdownViewer from './components/viewer/MarkdownViewer'
import ChunkViewer from './components/viewer/ChunkViewer'
import SettingsModal from './components/modals/SettingsModal'
import ProgressModal from './components/modals/ProgressModal'
import Toast from './components/viewer/Toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useDocument } from './hooks/useDocument'
import { useChunks } from './hooks/useChunks'
import { useBulkOps } from './hooks/useBulkOps'
import type { BulkProgressFn, BulkResultFn } from './hooks/useDocument'
import { loadSplitPct, saveSplitPct } from './hooks/useSettings'
import PDFViewer from './components/viewer/PDFViewer'
import './App.css'

interface ToastState {
  message: string
  type: 'success' | 'error'
  id: number
}

export default function App() {
  // ── Toast ───────────────────────────────────────────────────
  const [toast, setToast] = useState<ToastState | null>(null)

  const toastIdRef = useRef(0)
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type, id: ++toastIdRef.current })
  }, [])

  // Stable reference — prevents Toast's useEffect timer from resetting on re-renders.
  const handleToastClose = useCallback(() => setToast(null), [])

  const toastCallbacks = useMemo(() => ({
    onSuccess: (msg: string) => showToast(msg, 'success'),
    onError: (msg: string) => showToast(msg, 'error'),
  }), [showToast])

  // ── Hooks ────────────────────────────────────────────────────
  const {
    documents, selectedDoc, documentData, loading, uploading, converting, convertingToPdf, savingMd,
    conversionProgress, conversionErrorMessage,
    selectDocument, refreshDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
    batchConvert, chunkAndSaveFile,
  } = useDocument(toastCallbacks)

  // ── UI state ─────────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [scrollSync, setScrollSync] = useState(true)
  const [leftView, setLeftView] = useState<'pdf' | 'markdown'>('pdf')
  const [rightView, setRightView] = useState<'markdown' | 'chunks'>('markdown')

  // Set of PDF filenames that have a corresponding markdown file.
  const [docsWithMarkdown, setDocsWithMarkdown] = useState<Set<string>>(new Set())

  const {
    chunks, settings, saving: savingChunks, chunking,
    applySettings, editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks, cancelChunking,
    enrichChunk,
  } = useChunks(documentData, selectedDoc, rightView === 'chunks', toastCallbacks)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pdfScale, setPdfScale] = useState(1.0)
  const [mdScale, setMdScale] = useState(1.0)
  const [mdPadding, setMdPadding] = useState(20)
  const [splitPct, setSplitPct] = useState(() => loadSplitPct())
  const [isDragging, setIsDragging] = useState(false)
  const leftPanelRef = useRef<HTMLDivElement>(null)
  const rightPanelRef = useRef<HTMLDivElement>(null)
  /** Pending document switch while a conversion/chunking is in progress. */
  const [pendingDoc, setPendingDoc] = useState<string | null>(null)

  // Reset to default layout when the selected doc has no markdown.
  useEffect(() => {
    if (!documentData) return
    if (!documentData.has_markdown) { setLeftView('pdf'); setRightView('markdown') }
  }, [selectedDoc, documentData?.has_markdown])

  const handleSetLeftView = (view: 'pdf' | 'markdown') => {
    if (view === 'markdown' && rightView === 'markdown') setRightView('chunks')
    setLeftView(view)
  }

  const handleSetRightView = (view: 'markdown' | 'chunks') => {
    if (view === 'markdown' && leftView === 'markdown') setLeftView('pdf')
    setRightView(view)
  }

  // ── Track which docs have markdown ────────────────────────────
  // Derive a stable string key so the fetch only fires when the document list
  // content changes, not when useDocument recreates the array with the same values.
  const documentsKey = useMemo(() => documents.join(','), [documents])
  useEffect(() => {
    if (documentsKey === '') { setDocsWithMarkdown(new Set()); return }
    fetch('/api/documents/metadata', { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : [])
      .then((meta: Array<{ filename: string; has_markdown: boolean }>) => {
        setDocsWithMarkdown(new Set(meta.filter(m => m.has_markdown).map(m => m.filename)))
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string })?.name
        if (name !== 'AbortError' && name !== 'TimeoutError') {
          console.error('Failed to fetch document metadata:', err)
        }
      })
  }, [documentsKey])

  // Keep docsWithMarkdown in sync when a single-file conversion or deletion occurs.
  useEffect(() => {
    if (!selectedDoc) return
    setDocsWithMarkdown(prev => {
      const next = new Set(prev)
      if (documentData?.has_markdown) next.add(selectedDoc)
      else next.delete(selectedDoc)
      return next
    })
  }, [selectedDoc, documentData?.has_markdown])

  // ── Persist split ratio ───────────────────────────────────────
  const splitPctRef = useRef(splitPct)
  splitPctRef.current = splitPct
  useEffect(() => {
    if (!isDragging) saveSplitPct(splitPctRef.current)
  }, [isDragging])

  const handleToggleScrollSync = useCallback(() => setScrollSync(v => !v), [])

  // ── Divider drag ─────────────────────────────────────────────
  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent) => {
      const container = document.querySelector('.viewers') as HTMLElement
      if (!container) return
      const rect = container.getBoundingClientRect()
      const pct = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
      splitPctRef.current = pct
      if (leftPanelRef.current) leftPanelRef.current.style.width = `${pct}%`
    }
    const onUp = () => {
      setIsDragging(false)
      setSplitPct(splitPctRef.current)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [isDragging])

  const handleConvert = useCallback(() => {
    convertToMarkdown(settings.converter, settings.vlm, settings.cloud)
  }, [convertToMarkdown, settings.converter, settings.vlm, settings.cloud])

  const converterLabel = settings.converter ?? 'Convert'

  const conversionDetail = selectedDoc
    ? conversionProgress && conversionProgress.total > 0
      ? `Converting page ${conversionProgress.current} of ${conversionProgress.total} — ${selectedDoc}`
      : selectedDoc
    : ''

  // ── Document selection with in-progress guard ─────────────────
  const handleSelectDocument = useCallback((filename: string) => {
    if (converting || convertingToPdf || chunking) {
      setPendingDoc(filename)
    } else {
      selectDocument(filename)
    }
  }, [converting, convertingToPdf, chunking, selectDocument])

  const confirmSwitch = useCallback(() => {
    if (!pendingDoc) return
    cancelConversion()
    cancelMdToPdfConversion()
    cancelChunking()
    selectDocument(pendingDoc)
    setPendingDoc(null)
  }, [pendingDoc, cancelConversion, cancelMdToPdfConversion, cancelChunking, selectDocument])

  const cancelSwitch = useCallback(() => setPendingDoc(null), [])

  // ── Bulk operations ───────────────────────────────────────────
  // Called by useBulkOps after a successful batch convert to refresh metadata
  // and the active document panel.
  const handleConvertSuccess = useCallback(async (succeededFiles: Set<string>) => {
    const meta: Array<{ filename: string; has_markdown: boolean }> = await fetch('/api/documents/metadata')
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
    setDocsWithMarkdown(new Set(meta.filter(m => m.has_markdown).map(m => m.filename)))
    if (selectedDoc && succeededFiles.has(selectedDoc)) await refreshDocument()
  }, [selectedDoc, refreshDocument])

  const {
    bulkOp, bulkConnectionLost, interruptBulk, handleBulkConvert, handleBulkChunk,
  } = useBulkOps({
    batchConvert,
    chunkAndSaveFile,
    settings,
    showToast,
    onConvertSuccess: handleConvertSuccess,
  })

  // Sidebar expects the bulk handlers typed with (filenames, onProgress, onResult).
  const handleBulkConvertForSidebar = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => handleBulkConvert(filenames, onProgress, onResult), [handleBulkConvert])

  const handleBulkChunkForSidebar = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => handleBulkChunk(filenames, onProgress, onResult), [handleBulkChunk])

  // ── Markdown panel helper — avoids duplicating MarkdownViewer props ──────
  const renderMarkdownPanel = (): React.ReactNode => {
    if (!documentData?.has_markdown) {
      return (
        <div className="md-not-found">
          <span className="static-icon">📄</span>
          <h2>Markdown not found</h2>
          <p>This document hasn't been converted yet.</p>
          <button onClick={handleConvert} disabled={converting}>
            ✨ Convert with {converterLabel}
          </button>
        </div>
      )
    }
    return (
      <MarkdownViewer
        content={documentData.md_content}
        scale={mdScale}
        onScaleChange={setMdScale}
        padding={mdPadding}
        onPaddingChange={setMdPadding}
        scrollSyncEnabled={scrollSync}
        onSaveMarkdown={saveMarkdown}
        onDeleteMarkdown={deleteMarkdown}
        savingMd={savingMd}
        sectionEnrichment={settings.sectionEnrichment}
        onEnrichSuccess={toastCallbacks.onSuccess}
        onEnrichError={toastCallbacks.onError}
      />
    )
  }

  return (
    <div className="app">
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={handleToastClose}
        />
      )}

      {/* ── Operation progress modals ── */}
      <ProgressModal
        isOpen={converting}
        title="PDF → Markdown"
        detail={conversionDetail}
        current={conversionProgress?.current ?? 0}
        total={conversionProgress?.total ?? 0}
        onInterrupt={cancelConversion}
        errorMessage={conversionErrorMessage ?? undefined}
      />
      <ProgressModal
        isOpen={chunking}
        title="Chunking Document"
        detail={selectedDoc ?? ''}
        current={0}
        total={0}
        onInterrupt={cancelChunking}
      />
      {bulkOp && (
        <ProgressModal
          isOpen
          title={bulkOp.title}
          detail={bulkOp.detail}
          current={bulkOp.current}
          total={bulkOp.total}
          onInterrupt={interruptBulk}
          errorMessage={bulkConnectionLost
            ? 'Connection lost — the operation may have been interrupted. You can safely start a new conversion.'
            : undefined}
        />
      )}

      {/* ── Confirm switch while processing ── */}
      {pendingDoc && (
        <div className="confirm-switch-overlay" onClick={cancelSwitch}>
          <div className="confirm-switch-dialog" onClick={e => e.stopPropagation()}>
            <p>
              A {converting || convertingToPdf ? 'conversion' : 'chunking'} is in progress.
              Switching documents will cancel it. Continue?
            </p>
            <div className="confirm-switch-actions">
              <button className="btn-secondary" onClick={cancelSwitch}>Stay</button>
              <button className="btn-danger" onClick={confirmSwitch}>Switch document</button>
            </div>
          </div>
        </div>
      )}

      <Sidebar
        documents={documents}
        selectedDoc={selectedDoc}
        onSelect={handleSelectDocument}
        onUpload={uploadFiles}
        uploading={uploading}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        onDelete={deleteDocuments}
        onBulkConvert={handleBulkConvertForSidebar}
        onBulkChunk={handleBulkChunkForSidebar}
        onOpenSettings={() => setSettingsOpen(true)}
        docsWithMarkdown={docsWithMarkdown}
      />

      <div className="main-content">
        {loading && <div className="loading-overlay" />}

        {!loading && !selectedDoc && (
          <div className="placeholder">
            <span>📄</span>
            <p>Select a document to get started</p>
          </div>
        )}

        {!loading && selectedDoc && documentData && (
          <>
            {/* ErrorBoundary resets when the selected document changes so a bad
                document doesn't permanently break the viewer. */}
            <ErrorBoundary key={selectedDoc}>
              <div className="viewers">
                {/* ── Left panel ── */}
                <div ref={leftPanelRef} className="viewer-panel" style={{ width: `${splitPct}%`, maxWidth: 'calc(100% - 8px)' }}>
                  <div className="panel-label">
                    <button
                      className={`panel-view-tab${leftView === 'pdf' ? ' active' : ''}`}
                      onClick={() => handleSetLeftView('pdf')}
                    >PDF</button>
                    <button
                      className={`panel-view-tab${leftView === 'markdown' ? ' active' : ''}`}
                      onClick={() => handleSetLeftView('markdown')}
                    >Markdown</button>
                  </div>
                  {leftView === 'pdf' ? (
                    documentData.has_pdf ? (
                      <PDFViewer
                        filename={selectedDoc}
                        scale={pdfScale}
                        onScaleChange={setPdfScale}
                        scrollSyncEnabled={scrollSync}
                        onToggleScrollSync={handleToggleScrollSync}
                      />
                    ) : (
                      <div className="md-not-found">
                        {convertingToPdf ? (
                          <>
                            <span className="hourglass-icon">⏳</span>
                            <h2>Converting to PDF…</h2>
                            <p>Please wait while we generate your PDF.</p>
                            <div className="converting-bar" />
                            <button className="btn-cancel-op" onClick={cancelMdToPdfConversion}>✕ Cancel</button>
                          </>
                        ) : (
                          <>
                            <span className="static-icon">📝</span>
                            <h2>No PDF available</h2>
                            <p>This document only has a Markdown file.</p>
                            <button onClick={convertMdToPdf}>✨ Convert to PDF</button>
                          </>
                        )}
                      </div>
                    )
                  ) : (
                    renderMarkdownPanel()
                  )}
                </div>

                {/* ── Divider ── */}
                <div
                  className="viewer-divider"
                  onMouseDown={() => setIsDragging(true)}
                  title="Drag to resize"
                >
                  <div className="viewer-divider-grip">
                    <span /><span />
                    <span /><span />
                    <span /><span />
                  </div>
                  <div className="viewer-divider-presets">
                    <div className="viewer-divider-presets-inner">
                      <button onClick={e => { e.stopPropagation(); setSplitPct(0) }} title="0 / 100">0·100</button>
                      <button onClick={e => { e.stopPropagation(); setSplitPct(40) }} title="40 / 60">40·60</button>
                      <button onClick={e => { e.stopPropagation(); setSplitPct(50) }} title="50 / 50">50·50</button>
                      <button onClick={e => { e.stopPropagation(); setSplitPct(60) }} title="60 / 40">60·40</button>
                      <button onClick={e => { e.stopPropagation(); setSplitPct(100) }} title="100 / 0">100·0</button>
                    </div>
                  </div>
                </div>

                {/* ── Right panel ── */}
                <div ref={rightPanelRef} className="viewer-panel" style={{ flex: '1 1 0', minWidth: 0 }}>
                  <div className="panel-label">
                    <button
                      className={`panel-view-tab${rightView === 'markdown' ? ' active' : ''}`}
                      onClick={() => handleSetRightView('markdown')}
                    >Markdown</button>
                    {documentData.has_markdown && (
                      <button
                        className={`panel-view-tab${rightView === 'chunks' ? ' active' : ''}`}
                        onClick={() => handleSetRightView('chunks')}
                      >Chunks</button>
                    )}
                  </div>
                  {rightView === 'markdown' ? (
                    renderMarkdownPanel()
                  ) : (
                    <ChunkViewer
                      chunks={chunks}
                      content={documentData.md_content}
                      chunksReady={!!chunks}
                      chunking={chunking}
                      savingChunks={savingChunks}
                      chunkEnrichment={settings.chunkEnrichment}
                      onEnrichChunk={enrichChunk}
                      onChunkEdit={editChunk}
                      onDeleteChunk={deleteChunk}
                      onDeleteChunks={deleteChunks}
                      onMergeChunks={mergeChunks}
                      onSaveChunks={saveChunks}
                      scrollSyncEnabled={scrollSync}
                      onEnrichSuccess={toastCallbacks.onSuccess}
                      onEnrichError={toastCallbacks.onError}
                    />
                  )}
                </div>
              </div>
            </ErrorBoundary>
          </>
        )}

        <SettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSave={applySettings}
          current={settings}
        />
      </div>
    </div>
  )
}
