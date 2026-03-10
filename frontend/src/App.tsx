import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/layout/Sidebar'
import Toolbar from './components/layout/Toolbar'
import MarkdownViewer from './components/viewer/MarkdownViewer'
import SettingsModal from './components/modals/SettingsModal'
import Toast from './components/viewer/Toast'
import { useDocument, useChunks } from './hooks/useDocument'
import PDFViewer from './components/viewer/PDFViewer'
import './App.css'

const CONVERTER_LABELS: Record<string, string> = {
  pymupdf: 'PyMuPDF',
  docling: 'Docling',
  markitdown: 'MarkItDown',
  vlm: 'VLM',
}

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
    documents, selectedDoc, documentData, loading, uploading, converting, savingMd,
    selectDocument, uploadFiles, deleteDocuments, convertToMarkdown, saveMarkdown, deleteMarkdown,
  } = useDocument(toastCallbacks)

  const {
    chunks, settings, saving: savingChunks,
    applySettings, editChunk, saveChunks,
  } = useChunks(documentData, selectedDoc, toastCallbacks)

  // ── UI state ─────────────────────────────────────────────────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [scrollSync, setScrollSync] = useState(true)
  const [chunkViz, setChunkViz] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pdfScale, setPdfScale] = useState(1.0)
  const [mdScale, setMdScale] = useState(1.0)
  const [mdPadding, setMdPadding] = useState(20)
  const [splitPct, setSplitPct] = useState(50)
  const [isDragging, setIsDragging] = useState(false)

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

      <Sidebar
        documents={documents}
        selectedDoc={selectedDoc}
        onSelect={selectDocument}
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
                <PDFViewer
                  filename={selectedDoc}
                  scale={pdfScale}
                  onScaleChange={setPdfScale}
                  scrollSyncEnabled={scrollSync}
                />
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
                    onSaveMarkdown={saveMarkdown}
                    onSaveChunks={saveChunks}
                    onDeleteMarkdown={deleteMarkdown}
                    savingMd={savingMd}
                    savingChunks={savingChunks}
                    chunksReady={!!chunks}
                  />
                ) : (
                  <div className="md-not-found">
                    {converting ? (
                      <>
                        <span className="hourglass-icon">⏳</span>
                        <h2>Converting…</h2>
                        <p>Please wait while we process your document.</p>
                        <div className="converting-bar" />
                      </>
                    ) : (
                      <>
                        <span className="static-icon">📄</span>
                        <h2>Markdown not found</h2>
                        <p>This document hasn't been converted yet.</p>
                        <button onClick={handleConvert}>
                          ✨ Convert with {CONVERTER_LABELS[settings.converter]}
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