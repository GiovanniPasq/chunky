import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/layout/Sidebar'
import Toolbar from './components/layout/Toolbar'
import MarkdownViewer from './components/viewer/MarkdownViewer'
import SettingsModal from './components/modals/SettingsModal'
import Toast from './components/viewer/Toast'
import { useDocument, useChunks } from './hooks/useDocument'
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
    conversionProgress,
    selectDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
  } = useDocument(toastCallbacks)

  // ── UI state ─────────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [scrollSync, setScrollSync] = useState(true)
  const [chunkViz, setChunkViz] = useState(false)

  const {
    chunks, settings, saving: savingChunks, chunking,
    applySettings, editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks, cancelChunking,
  } = useChunks(documentData, selectedDoc, chunkViz, toastCallbacks)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pdfScale, setPdfScale] = useState(1.0)
  const [mdScale, setMdScale] = useState(1.0)
  const [mdPadding, setMdPadding] = useState(20)
  const [splitPct, setSplitPct] = useState(50)
  const [isDragging, setIsDragging] = useState(false)
  /** Pending document switch while a conversion/chunking is in progress. */
  const [pendingDoc, setPendingDoc] = useState<string | null>(null)

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
              <div className="viewer-panel" style={{ width: `${splitPct}%` }}>
                <div className="panel-label">PDF</div>
                {documentData.has_pdf ? (
                  <PDFViewer
                    filename={selectedDoc}
                    scale={pdfScale}
                    onScaleChange={setPdfScale}
                    scrollSyncEnabled={scrollSync}
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

              <div className="viewer-divider" onMouseDown={() => setIsDragging(true)} />

              <div className="viewer-panel" style={{ width: `${100 - splitPct}%` }}>
                <div className="panel-label">MARKDOWN</div>
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
                  />
                ) : (
                  <div className="md-not-found">
                    {converting ? (
                      <>
                        <span className="hourglass-icon">⏳</span>
                        <h2>Converting…</h2>
                        {conversionProgress != null && conversionProgress.total > 0 ? (
                          <p>
                            Page {conversionProgress.current} of {conversionProgress.total}
                            {' '}({Math.round(conversionProgress.current / conversionProgress.total * 100)}%)
                          </p>
                        ) : (
                          <p>Please wait while we process your document.</p>
                        )}
                        <div className="converting-bar" />
                        <button className="btn-cancel-op" onClick={cancelConversion}>
                          ✕ Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="static-icon">📄</span>
                        <h2>Markdown not found</h2>
                        <p>This document hasn't been converted yet.</p>
                        <button onClick={handleConvert}>
                          ✨ Convert with {converterLabel}
                        </button>
                      </>
                    )}
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
          current={settings}
        />
      </div>
    </div>
  )
}