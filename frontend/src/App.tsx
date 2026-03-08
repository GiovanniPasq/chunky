import { useState, useEffect } from 'react'
import Sidebar from './components/layout/Sidebar'
import Toolbar from './components/layout/Toolbar'
import MarkdownViewer from './components/viewer/MarkdownViewer'
import ChunkSettingsModal from './components/chunks/ChunkSettingsModal'
import { useDocument, useChunks } from './hooks/useDocument'
import PDFViewer from './components/viewer/PDFViewer'
import './App.css'

export default function App() {
  const {
    documents, selectedDoc, documentData, loading, uploading, converting, savingMd,
    selectDocument, uploadFiles, deleteDocuments, convertToMarkdown, saveMarkdown,
  } = useDocument()

  const {
    chunks, settings, saving: savingChunks,
    applySettings, editChunk, saveChunks,
  } = useChunks(documentData, selectedDoc)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [scrollSync, setScrollSync] = useState(true)
  const [chunkViz, setChunkViz] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pdfScale, setPdfScale] = useState(1.0)
  const [mdScale, setMdScale] = useState(1.0)
  const [mdPadding, setMdPadding] = useState(20)
  const [splitPct, setSplitPct] = useState(50)
  const [isDragging, setIsDragging] = useState(false)

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

  return (
    <div className="app">
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
              chunksReady={!!chunks}
              onToggleScrollSync={() => setScrollSync(v => !v)}
              onToggleChunkViz={() => setChunkViz(v => !v)}
              onOpenSettings={() => setSettingsOpen(true)}
              onSaveChunks={saveChunks}
              savingChunks={savingChunks}
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
                    savingMd={savingMd}
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
                        <button onClick={convertToMarkdown}>
                          ✨ Convert to Markdown
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <ChunkSettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSave={applySettings}
          current={settings}
        />
      </div>
    </div>
  )
}