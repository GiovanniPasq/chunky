import { useEffect, useMemo, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { BulkProgressFn, BulkResultFn } from '../../hooks/useDocument'
import type { DeleteDocumentsResponse } from '../../services/documentsApi'
import logoSrc from '../../assets/logo.png'
import './Sidebar.css'

const FAILED_TOOLTIP_TEXT =
  'Partial VLM conversion — saved Markdown contains failed pages. Open it to preview the partial result, then click Convert to retry.'

const CHECKPOINT_TOOLTIP_TEXT =
  'Interrupted VLM conversion — some pages are cached, but no updated preview was published yet. Click Convert to resume.'

interface Props {
  documents: string[]
  selectedDoc: string | null
  onSelect: (doc: string) => void
  onUpload: (files: File[]) => void
  uploading: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onDelete: (filenames: string[]) => Promise<DeleteDocumentsResponse>
  onBulkConvert?: (filenames: string[], onProgress: BulkProgressFn, onResult: BulkResultFn) => Promise<void>
  onBulkChunk?: (filenames: string[], onProgress: BulkProgressFn, onResult: BulkResultFn) => Promise<void>
  /**
   * Optional bulk markdown enrichment.  Available when the sidebar is
   * given a handler; the corresponding button is hidden otherwise.
   * Selected files without any markdown variant are skipped at runtime
   * by the handler (mirrors the Chunk button's behaviour).
   */
  onBulkEnrich?: (filenames: string[], onProgress: BulkProgressFn, onResult: BulkResultFn) => Promise<void>
  /**
   * Optional bulk chunk enrichment.  Enriches saved chunks for each selected
   * document, or chunks first when no matching saved set exists.
   */
  onBulkChunkEnrich?: (filenames: string[], onProgress: BulkProgressFn, onResult: BulkResultFn) => Promise<void>
  onOpenSettings?: () => void
  docsWithMarkdown?: Set<string>
  /** PDFs whose saved VLM Markdown contains failed-page placeholders. */
  docsWithFailures?: Set<string>
  /**
   * PDFs with a resumable VLM checkpoint. Unlike failed Markdown, this may not
   * have a preview yet because the run was interrupted before publication.
   */
  docsWithCheckpoints?: Set<string>
  /** Disable sidebar keyboard shortcuts while modal/operation flows own input. */
  keyboardNavigationDisabled?: boolean
}

interface BulkOpState {
  type: 'convert' | 'chunk' | 'enrich' | 'chunk-enrich'
  current: number
  total: number
  currentFile: string
  results: Map<string, boolean>
}

export default function Sidebar({
  documents, selectedDoc, onSelect, onUpload, uploading,
  collapsed, onToggleCollapse, onDelete,
  onBulkConvert, onBulkChunk, onBulkEnrich, onBulkChunkEnrich,
  onOpenSettings, docsWithMarkdown, docsWithFailures, docsWithCheckpoints,
  keyboardNavigationDisabled = false,
}: Props) {
  const [search, setSearch] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [bulkOp, setBulkOp] = useState<BulkOpState | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [warningTip, setWarningTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const lastSelectedDocRef = useRef<string | null>(null)

  const showWarningTip = (
    e: React.MouseEvent<HTMLSpanElement> | React.FocusEvent<HTMLSpanElement>,
    text: string,
  ) => {
    const r = e.currentTarget.getBoundingClientRect()
    setWarningTip({ x: r.right, y: r.top, text })
  }
  const hideWarningTip = () => setWarningTip(null)

  const filtered = useMemo(
    () => documents.filter(d => d.toLowerCase().includes(search.toLowerCase())),
    [documents, search],
  )
  const selectedVisible = useMemo(
    () => filtered.filter(doc => selected.has(doc)),
    [filtered, selected],
  )
  const visibleSelectedCount = selectedVisible.length

  useEffect(() => {
    const existing = new Set(documents)
    setSelected(prev => {
      const next = new Set(Array.from(prev).filter(doc => existing.has(doc)))
      return next.size === prev.size ? prev : next
    })
    if (lastSelectedDocRef.current && !existing.has(lastSelectedDocRef.current)) {
      lastSelectedDocRef.current = null
    }
  }, [documents])

  // Keyboard document navigation.  It deliberately walks the visible
  // filtered list, not the full document list, so hidden search results
  // cannot be selected by Alt/Option + Arrow.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
      if (event.metaKey || event.ctrlKey || event.shiftKey) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (collapsed || keyboardNavigationDisabled || deleting || bulkOp !== null || uploading) return

      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return
      if (!selectedDoc || filtered.length === 0) return

      const currentIndex = filtered.indexOf(selectedDoc)
      if (currentIndex === -1) return

      const nextIndex = event.key === 'ArrowDown'
        ? Math.min(filtered.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1)
      if (nextIndex === currentIndex) return

      event.preventDefault()
      onSelect(filtered[nextIndex])
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    filtered,
    selectedDoc,
    onSelect,
    collapsed,
    keyboardNavigationDisabled,
    deleting,
    bulkOp,
    uploading,
  ])

  useEffect(() => {
    if (!selectedDoc || collapsed) return
    rowRefs.current.get(selectedDoc)?.scrollIntoView({ block: 'nearest' })
  }, [selectedDoc, collapsed])

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onUpload(files)
    e.target.value = ''
  }

  const acceptFile = (f: File) => /\.(pdf|md)$/i.test(f.name)

  const handleDragEnter = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (uploading) return
    dragDepthRef.current += 1
    setDragOver(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (uploading) {
      e.dataTransfer.dropEffect = 'none'
    } else {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setDragOver(false)
    if (uploading) return
    const files = Array.from(e.dataTransfer.files ?? []).filter(acceptFile)
    if (files.length > 0) onUpload(files)
  }

  const toggleSelectMode = () => {
    setSelectMode(v => !v)
    setSelected(new Set())
    lastSelectedDocRef.current = null
  }

  const toggleDoc = (doc: string, shiftKey: boolean) => {
    setSelected(prev => {
      const anchor = lastSelectedDocRef.current
      const next = new Set(prev)
      const currentIndex = filtered.indexOf(doc)
      const anchorIndex = anchor ? filtered.indexOf(anchor) : -1

      if (shiftKey && anchorIndex !== -1 && currentIndex !== -1) {
        const [start, end] = anchorIndex < currentIndex
          ? [anchorIndex, currentIndex]
          : [currentIndex, anchorIndex]
        filtered.slice(start, end + 1).forEach(filename => next.add(filename))
      } else {
        next.has(doc) ? next.delete(doc) : next.add(doc)
      }
      return next
    })
    lastSelectedDocRef.current = doc
    onSelect(doc)
  }

  const allFilteredSelected = filtered.length > 0 && filtered.every(doc => selected.has(doc))

  const toggleSelectAll = () => {
    lastSelectedDocRef.current = null
    if (allFilteredSelected) {
      setSelected(prev => {
        const next = new Set(prev)
        filtered.forEach(doc => next.delete(doc))
        return next
      })
    } else {
      setSelected(new Set(filtered))
    }
  }

  const handleDeleteSelected = async () => {
    if (visibleSelectedCount === 0) return
    setDeleting(true)
    try {
      const result = await onDelete(selectedVisible)
      const failed = new Set(Object.keys(result.failed))
      setSelected(failed)
      lastSelectedDocRef.current = null
      if (failed.size === 0) setSelectMode(false)
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteSingle = async (e: React.MouseEvent, doc: string) => {
    e.stopPropagation()
    setDeleting(true)
    try {
      const result = await onDelete([doc])
      if (result.failed[doc]) setSelected(prev => new Set(prev).add(doc))
    } finally {
      setDeleting(false)
    }
  }

  const runBulkOp = async (type: BulkOpState['type'], handler: typeof onBulkConvert) => {
    if (!handler || visibleSelectedCount === 0) return
    // Chunking and enrichment both require markdown — skip files
    // without any variant on disk.  Conversion takes the raw PDF
    // list as-is.
    const filenames = (type === 'chunk' || type === 'enrich' || type === 'chunk-enrich')
      ? selectedVisible.filter(f => docsWithMarkdown?.has(f))
      : selectedVisible
    if (filenames.length === 0) return
    const results = new Map<string, boolean>()

    setBulkOp({ type, current: 0, total: filenames.length, currentFile: '', results })

    const onProgress: BulkProgressFn = (current, total, filename) =>
      setBulkOp(prev => prev ? { ...prev, current, total, currentFile: filename } : prev)

    const onResult: BulkResultFn = (filename, success) => {
      results.set(filename, success)
      setBulkOp(prev => prev ? { ...prev, results } : prev)
    }

    try {
      await handler(filenames, onProgress, onResult)
    } finally {
      setBulkOp(null)
      setSelected(new Set())
      setSelectMode(false)
      lastSelectedDocRef.current = null
    }
  }

  const isBusy = deleting || bulkOp !== null

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>

      {/* ── Fixed top ── */}
      <div className="sidebar-fixed">

        <div className="sidebar-brand">
          <img src={logoSrc} alt="logo" className="sidebar-logo" />
          {!collapsed && <span className="sidebar-app-name">Chunky</span>}
        </div>

        {collapsed ? (
          <div className="sidebar-collapsed-toggle">
            <button className="menu-toggle" onClick={onToggleCollapse} title="Expand sidebar">☰</button>
          </div>
        ) : (
          <>
            <div className="sidebar-divider" />

            <div className="sidebar-section-row">
              <button className="menu-toggle" onClick={onToggleCollapse} title="Collapse sidebar">☰</button>
              <span className="sidebar-section-label">Documents</span>
            </div>

            <div className="sidebar-upload">
              <input
                ref={fileInputRef}
                type="file"
                id="file-upload"
                accept=".pdf,.md"
                multiple
                onChange={handleFiles}
                style={{ display: 'none' }}
              />
              <label
                htmlFor="file-upload"
                className={`upload-btn${dragOver ? ' drag-over' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {uploading
                  ? <><span>⏳</span> Uploading…</>
                  : dragOver
                    ? <><span>📥</span> Drop to upload</>
                    : <><span>📤</span> Upload PDF / MD</>}
              </label>
            </div>

            <div className="sidebar-search">
              <input
                type="text"
                placeholder="Search documents…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="search-input"
              />
            </div>

            <div className="doc-count-row">
              <span className="doc-count">
                {filtered.length} / {documents.length}{' '}
                {documents.length === 1 ? 'document' : 'documents'}
              </span>
              {documents.length > 0 && (
                <button
                  className={`select-toggle-btn ${selectMode ? 'active' : ''}`}
                  onClick={toggleSelectMode}
                  title={selectMode ? 'Cancel selection' : 'Select documents'}
                  disabled={isBusy}
                >
                  {selectMode ? '✕' : 'Select'}
                </button>
              )}
            </div>

            {selectMode && (
              <>
                <div className="bulk-actions">
                  <button
                    className="bulk-btn select-all"
                    onClick={toggleSelectAll}
                    disabled={filtered.length === 0 || isBusy}
                  >
                    {allFilteredSelected ? 'Deselect all' : 'Select all'}
                  </button>
                  <button
                    className="bulk-btn delete-selected"
                    onClick={handleDeleteSelected}
                    disabled={visibleSelectedCount === 0 || isBusy}
                  >
                    {deleting
                      ? '⏳ Deleting…'
                      : `🗑 Delete${visibleSelectedCount > 0 ? ` (${visibleSelectedCount})` : ''}`}
                  </button>
                </div>

                {(onBulkConvert || onBulkChunk || onBulkEnrich || onBulkChunkEnrich) && (
                  <div className="bulk-actions bulk-actions-secondary">
                    {onBulkConvert && (
                      <button
                        className="bulk-btn convert-selected"
                        onClick={() => runBulkOp('convert', onBulkConvert)}
                        disabled={visibleSelectedCount === 0 || isBusy}
                      >
                        {bulkOp?.type === 'convert'
                          ? `⏳ ${bulkOp.current}/${bulkOp.total}`
                          : `✨ Convert${visibleSelectedCount > 0 ? ` (${visibleSelectedCount})` : ''}`}
                      </button>
                    )}
                    {onBulkChunk && (() => {
                      const chunkable = selectedVisible.filter(f => docsWithMarkdown?.has(f)).length
                      return (
                        <button
                          className="bulk-btn chunk-selected"
                          onClick={() => runBulkOp('chunk', onBulkChunk)}
                          disabled={chunkable === 0 || isBusy}
                          title={visibleSelectedCount > chunkable ? `${visibleSelectedCount - chunkable} visible selected file(s) have no markdown and will be skipped` : undefined}
                        >
                          {bulkOp?.type === 'chunk'
                            ? `⏳ ${bulkOp.current}/${bulkOp.total}`
                            : `⛓ Chunk${chunkable > 0 ? ` (${chunkable})` : ''}`}
                        </button>
                      )
                    })()}
                    {onBulkEnrich && (() => {
                      const enrichable = selectedVisible.filter(f => docsWithMarkdown?.has(f)).length
                      return (
                        <button
                          className="bulk-btn enrich-selected"
                          onClick={() => runBulkOp('enrich', onBulkEnrich)}
                          disabled={enrichable === 0 || isBusy}
                          title={visibleSelectedCount > enrichable ? `${visibleSelectedCount - enrichable} visible selected file(s) have no markdown and will be skipped` : 'Bulk enrichment skips the summary review modal and uses any cached summary silently.'}
                        >
                          {bulkOp?.type === 'enrich'
                            ? `⏳ ${bulkOp.current}/${bulkOp.total}`
                            : `✨ Enrich MD${enrichable > 0 ? ` (${enrichable})` : ''}`}
                        </button>
                      )
                    })()}
                    {onBulkChunkEnrich && (() => {
                      const enrichable = selectedVisible.filter(f => docsWithMarkdown?.has(f)).length
                      return (
                        <button
                          className="bulk-btn chunk-enrich-selected"
                          onClick={() => runBulkOp('chunk-enrich', onBulkChunkEnrich)}
                          disabled={enrichable === 0 || isBusy}
                          title={visibleSelectedCount > enrichable ? `${visibleSelectedCount - enrichable} visible selected file(s) have no markdown and will be skipped` : 'Enrich saved chunks, or chunk first when no matching saved chunks exist.'}
                        >
                          {bulkOp?.type === 'chunk-enrich'
                            ? `⏳ ${bulkOp.current}/${bulkOp.total}`
                            : `✨ Enrich Chunks${enrichable > 0 ? ` (${enrichable})` : ''}`}
                        </button>
                      )
                    })()}
                  </div>
                )}

                {bulkOp && (
                  <div className="bulk-progress">
                    <span className="bulk-progress-label">
                      {bulkOp.type === 'convert' ? 'Converting' :
                        bulkOp.type === 'chunk' ? 'Chunking' :
                          bulkOp.type === 'chunk-enrich' ? 'Enriching chunks' : 'Enriching markdown'}{' '}
                      {bulkOp.current}/{bulkOp.total}
                    </span>
                    {bulkOp.currentFile && (
                      <span className="bulk-progress-file" title={bulkOp.currentFile}>
                        {bulkOp.currentFile}
                      </span>
                    )}
                    <div className="bulk-progress-results">
                      {Array.from(bulkOp.results.entries()).map(([file, ok]) => (
                        <span
                          key={file}
                          className={`bulk-result-dot ${ok ? 'ok' : 'fail'}`}
                          title={`${file}: ${ok ? 'success' : 'failed'}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* ── Scrollable list ── */}
      {!collapsed && (
        <div className="sidebar-list-scroll">
          <ul className="doc-list">
            {filtered.length === 0
              ? <li className="no-docs">No results</li>
              : filtered.map(doc => {
                  const isSelected = selected.has(doc)
                  const isActive = selectedDoc === doc
                  const hasFailedMarkdown = docsWithFailures?.has(doc) ?? false
                  const hasCheckpointOnly = !hasFailedMarkdown && (docsWithCheckpoints?.has(doc) ?? false)
                  const statusText = hasFailedMarkdown
                    ? FAILED_TOOLTIP_TEXT
                    : hasCheckpointOnly
                      ? CHECKPOINT_TOOLTIP_TEXT
                      : null
                  return (
                    <li
                      key={doc}
                      ref={el => {
                        if (el) rowRefs.current.set(doc, el)
                        else rowRefs.current.delete(doc)
                      }}
                      className={[
                        isActive ? 'active' : '',
                        selectMode && isSelected ? 'selected' : '',
                      ].filter(Boolean).join(' ')}
                      onMouseDown={e => { if (selectMode) e.preventDefault() }}
                      onClick={e => selectMode ? toggleDoc(doc, e.shiftKey) : onSelect(doc)}
                      title={doc}
                    >
                      {selectMode && (
                        <button
                          type="button"
                          className={`doc-checkbox ${isSelected ? 'checked' : ''}`}
                          role="checkbox"
                          aria-checked={isSelected}
                          aria-label={`${isSelected ? 'Deselect' : 'Select'} ${doc}`}
                          onClick={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleDoc(doc, e.shiftKey)
                          }}
                        />
                      )}
                      <span className="doc-icon">📄</span>
                      <span className="doc-name">{doc}</span>
                      {statusText && (
                        <span
                          className={`doc-warning-badge${hasCheckpointOnly ? ' checkpoint' : ''}`}
                          aria-label={statusText}
                          tabIndex={0}
                          onMouseEnter={e => showWarningTip(e, statusText)}
                          onMouseLeave={hideWarningTip}
                          onFocus={e => showWarningTip(e, statusText)}
                          onBlur={hideWarningTip}
                        >
                          {/* Inline SVG indicators.  Render identically
                              across platforms (no Unicode/emoji font roulette),
                              inherits the colour via ``currentColor``, and
                              matches the stroke style used elsewhere in the
                              app (see the password-toggle icons). */}
                          {hasCheckpointOnly ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M20 12a8 8 0 1 1-2.35-5.65" />
                              <path d="M20 4v5h-5" />
                            </svg>
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                          )}
                        </span>
                      )}
                      {docsWithMarkdown?.has(doc) && (
                        <span className="doc-md-badge" title="Markdown available">MD</span>
                      )}
                      {!selectMode && (
                        <button
                          className="doc-delete-btn"
                          onClick={e => handleDeleteSingle(e, doc)}
                          title={`Delete ${doc}`}
                          disabled={deleting}
                        >
                          🗑
                        </button>
                      )}
                    </li>
                  )
                })
            }
          </ul>
          {documents.length > 0 && (
            <div
              className="shortcut-hint"
              title="Use Alt/Option plus Arrow Up or Arrow Down to switch documents"
            >
              Alt/Option + ↑↓ to switch documents
            </div>
          )}
        </div>
      )}

      {/* ── Settings button at bottom ── */}
      {onOpenSettings && (
        <div className={`sidebar-settings-footer ${collapsed ? 'collapsed' : ''}`}>
          <button
            className="sidebar-settings-btn"
            onClick={onOpenSettings}
            title="Settings"
          >
            <span className="sidebar-settings-icon">⚙️</span>
            {!collapsed && <span className="sidebar-settings-label">Settings</span>}
          </button>
        </div>
      )}

      {warningTip && createPortal(
        <div
          className="doc-warning-tooltip"
          role="tooltip"
          style={{ left: warningTip.x + 8, top: warningTip.y }}
        >
          {warningTip.text}
        </div>,
        document.body,
      )}
    </div>
  )
}
