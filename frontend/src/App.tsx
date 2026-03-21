import { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/layout/Sidebar'
import Toolbar from './components/layout/Toolbar'
import MarkdownViewer from './components/viewer/MarkdownViewer'
import SettingsModal from './components/modals/SettingsModal'
import ProgressModal from './components/modals/ProgressModal'
import Toast from './components/viewer/Toast'
import { useDocument, useChunks } from './hooks/useDocument'
import type { BulkProgressFn, BulkResultFn } from './hooks/useDocument'
import type { ConverterType, VLMSettings } from './types'
import { loadSplitPct, saveSplitPct, DEFAULT_SPLIT_PCT, clearPersistedSettings } from './hooks/useSettings'
import PDFViewer from './components/viewer/PDFViewer'
import './App.css'

interface ToastState {
  message: string
  type: 'success' | 'error'
  id: number
}

interface BulkOp {
  title: string
  detail: string
  current: number
  total: number
}

export default function App() {
  // ── Toast ───────────────────────────────────────────────────
  const [toast, setToast] = useState<ToastState | null>(null)

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type, id: Date.now() })
  }, [])

  const toastCallbacks = {
    onSuccess: (msg: string) => showToast(msg, 'success'),
    onError: (msg: string) => showToast(msg, 'error'),
  }

  // ── Hooks ────────────────────────────────────────────────────
  const {
    documents, selectedDoc, documentData, loading, uploading, converting, convertingToPdf, savingMd,
    conversionProgress, conversionErrorMessage,
    selectDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
    batchConvert, chunkAndSaveFile,
  } = useDocument(toastCallbacks)

  // ── UI state ─────────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [scrollSync, setScrollSync] = useState(true)
  const [chunkViz, setChunkViz] = useState(false)
  const [pdfHidden, setPdfHidden] = useState(false)

  const {
    chunks, settings, saving: savingChunks, chunking,
    applySettings, resetSettings, editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks, cancelChunking,
    enrichChunk,
  } = useChunks(documentData, selectedDoc, chunkViz, toastCallbacks)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pdfScale, setPdfScale] = useState(1.0)
  const [mdScale, setMdScale] = useState(1.0)
  const [mdPadding, setMdPadding] = useState(20)
  const [splitPct, setSplitPct] = useState(() => loadSplitPct())
  const [isDragging, setIsDragging] = useState(false)
  /** Pending document switch while a conversion/chunking is in progress. */
  const [pendingDoc, setPendingDoc] = useState<string | null>(null)

  // ── Bulk operation modal state ────────────────────────────────
  const [bulkOp, setBulkOp] = useState<BulkOp | null>(null)
  const bulkAbortRef = useRef<AbortController | null>(null)
  const [bulkConnectionLost, setBulkConnectionLost] = useState(false)

  // ── Persist split ratio ───────────────────────────────────────
  const splitPctRef = useRef(splitPct)
  splitPctRef.current = splitPct
  useEffect(() => {
    if (!isDragging) saveSplitPct(splitPctRef.current)
  }, [isDragging])

  // ── Reset to defaults ─────────────────────────────────────────
  const handleReset = useCallback(() => {
    clearPersistedSettings()
    resetSettings()
    setSplitPct(DEFAULT_SPLIT_PCT)
  }, [resetSettings])

  // ── Divider drag ─────────────────────────────────────────────
  useEffect(() => {
    if (!isDragging) return
    const onMove = (e: MouseEvent) => {
      const container = document.querySelector('.viewers') as HTMLElement
      if (!container) return
      const rect = container.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      if (pct >= 20 && pct <= 80) setSplitPct(pct)
    }
    const onUp = () => setIsDragging(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [isDragging])

  const handleConvert = () =>
    convertToMarkdown(settings.converter, settings.vlm)

  const converterLabel = settings.converter ?? 'Convert'

  // Descriptive detail text for the single-conversion modal.
  // When VLM is active, conversionProgress carries per-page counts.
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

  // ── Bulk convert (concurrent via batch endpoint + SSE) ────────
  const handleBulkConvert = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()

    setBulkOp({ title: 'Batch PDF → Markdown', detail: '', current: 0, total: filenames.length })
    setBulkConnectionLost(false)

    let succeeded = 0
    let failed = 0

    try {
      await batchConvert(
        filenames,
        settings.converter as ConverterType,
        settings.vlm as VLMSettings | undefined,
        (filename, index, total) => {
          // file_start: set baseline detail text; VLM will overwrite it per-page
          setBulkOp(prev => prev
            ? { ...prev, detail: `File ${index} of ${total} — ${filename}` }
            : null
          )
        },
        (filename, success) => {
          onResult(filename, success)
          if (success) succeeded++
          else failed++
        },
        (current, total, filename, _percentage) => {
          // file_progress: fired after each file completes — advance the progress bar
          onProgress(current, total, filename)
          setBulkOp(prev => prev
            ? { ...prev, current }
            : null
          )
        },
        bulkAbortRef.current.signal,
        () => setBulkConnectionLost(true),
        (filename, page, totalPages, fileIndex, fileTotal) => {
          // VLM per-page progress: update detail text only — bar stays at file level
          setBulkOp(prev => prev
            ? {
                ...prev,
                detail: `Converting page ${page} of ${totalPages} — ${filename} (file ${fileIndex} of ${fileTotal})`,
              }
            : null
          )
        },
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled — show partial results below
      }
    }

    setBulkOp(null)
    setBulkConnectionLost(false)
    if (succeeded > 0) showToast(`Converted ${succeeded} file${succeeded > 1 ? 's' : ''} ✓`, 'success')
    if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to convert`, 'error')
  }, [batchConvert, settings.converter, settings.vlm, showToast])

  // ── Bulk chunk (sequential, interruptible via AbortController) ─
  const handleBulkChunk = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()
    const { signal } = bulkAbortRef.current

    setBulkOp({ title: 'Batch Chunking', detail: '', current: 0, total: filenames.length })

    let succeeded = 0
    let failed = 0

    for (let i = 0; i < filenames.length; i++) {
      if (signal.aborted) break

      const filename = filenames[i]
      onProgress(i + 1, filenames.length, filename)
      setBulkOp(prev => prev
        ? { ...prev, detail: `File ${i + 1} of ${filenames.length} — ${filename}`, current: i + 1 }
        : null
      )

      try {
        await chunkAndSaveFile(filename, settings)
        onResult(filename, true)
        succeeded++
      } catch {
        onResult(filename, false)
        failed++
      }
    }

    setBulkOp(null)
    if (succeeded > 0) showToast(`Chunked ${succeeded} file${succeeded > 1 ? 's' : ''} ✓`, 'success')
    if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to chunk`, 'error')
  }, [chunkAndSaveFile, settings, showToast])

  return (
    <div className="app">
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* ── Operation progress modals (block all UI while active) ── */}
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
          onInterrupt={() => { bulkAbortRef.current?.abort(); setBulkConnectionLost(false) }}
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
        onBulkConvert={handleBulkConvert}
        onBulkChunk={handleBulkChunk}
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
            <Toolbar
              scrollSync={scrollSync}
              chunkViz={chunkViz}
              onToggleScrollSync={() => setScrollSync(v => !v)}
              onToggleChunkViz={() => setChunkViz(v => !v)}
              onOpenSettings={() => setSettingsOpen(true)}
            />

            <div className="viewers">
              {!pdfHidden && (
                <div className="viewer-panel" style={{ width: `${splitPct}%` }}>
                  <div className="panel-label">PDF</div>
                  {documentData.has_pdf ? (
                    <PDFViewer
                      filename={selectedDoc}
                      scale={pdfScale}
                      onScaleChange={setPdfScale}
                      scrollSyncEnabled={scrollSync}
                      onHide={() => setPdfHidden(true)}
                    />
                  ) : (
                    <div className="md-not-found">
                      {convertingToPdf ? (
                        <>
                          <span className="hourglass-icon">⏳</span>
                          <h2>Converting to PDF…</h2>
                          <p>Please wait while we generate your PDF.</p>
                          <div className="converting-bar" />
                          <button className="btn-cancel-op" onClick={cancelMdToPdfConversion}>
                            ✕ Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="static-icon">📝</span>
                          <h2>No PDF available</h2>
                          <p>This document only has a Markdown file.</p>
                          <button onClick={convertMdToPdf}>
                            ✨ Convert to PDF
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!pdfHidden && (
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
                    <button onClick={e => { e.stopPropagation(); setSplitPct(40) }} title="40 / 60">40·60</button>
                    <button onClick={e => { e.stopPropagation(); setSplitPct(50) }} title="50 / 50">50·50</button>
                    <button onClick={e => { e.stopPropagation(); setSplitPct(60) }} title="60 / 40">60·40</button>
                  </div>
                </div>
              )}

              <div className="viewer-panel" style={{ width: pdfHidden ? '100%' : `${100 - splitPct}%` }}>
                <div className="panel-label">
                  {pdfHidden && (
                    <button
                      className="show-pdf-btn"
                      onClick={() => setPdfHidden(false)}
                      title="Show PDF panel"
                    >
                      PDF →
                    </button>
                  )}
                  MARKDOWN
                </div>
                {documentData.has_markdown ? (
                  <MarkdownViewer
                    content={documentData.md_content}
                    scale={mdScale}
                    onScaleChange={setMdScale}
                    padding={mdPadding}
                    onPaddingChange={setMdPadding}
                    scrollSyncEnabled={scrollSync}
                    chunks={chunks}
                    chunkVisualizationEnabled={chunkViz}
                    onChunkEdit={editChunk}
                    onEnrichChunk={enrichChunk}
                    onDeleteChunk={deleteChunk}
                    onDeleteChunks={deleteChunks}
                    onMergeChunks={mergeChunks}
                    onSaveMarkdown={saveMarkdown}
                    onSaveChunks={saveChunks}
                    onDeleteMarkdown={deleteMarkdown}
                    savingMd={savingMd}
                    savingChunks={savingChunks}
                    chunksReady={!!chunks}
                    chunking={chunking}
                    onCancelChunking={cancelChunking}
                    sectionEnrichment={settings.sectionEnrichment}
                    chunkEnrichment={settings.chunkEnrichment}
                  />
                ) : (
                  <div className="md-not-found">
                    <span className="static-icon">📄</span>
                    <h2>Markdown not found</h2>
                    <p>This document hasn't been converted yet.</p>
                    <button onClick={handleConvert} disabled={converting}>
                      ✨ Convert with {converterLabel}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <SettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSave={applySettings}
          onReset={handleReset}
          current={settings}
        />
      </div>
    </div>
  )
}
