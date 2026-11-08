import FeatureIcon from '../common/FeatureIcon'
import { useEffect, useMemo, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { BulkProgressFn, BulkResultFn } from '../../hooks/useDocument'
import type { DeleteDocumentsResponse } from '../../services/documentsApi'
import BrandLogo from '../common/BrandLogo'
import {
  IconMenu,
  IconWarning,
  IconDownload,
  IconSidebarCollapse,
  IconSearch,
  IconUpload,
  IconPdf,
  IconMarkdown,
  IconFile,
  IconTrash,
  IconSettings,
  IconSpinner,
  IconClose,
} from '../common/Icons'
import StatusBadge from '../common/StatusBadge'
import { getDocumentStatus, type DocumentStage } from '../../utils/documentStatus'
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
  onExport?: (filenames: string[]) => void
  onOpenSettings?: () => void
  processingDoc?: string | null
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
  onExport, onOpenSettings, processingDoc, docsWithMarkdown, docsWithFailures, docsWithCheckpoints,
  keyboardNavigationDisabled = false,
}: Props) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<DocumentStage | 'all'>('all')
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

  const statuses = useMemo(() => new Map(documents.map(doc => [doc, getDocumentStatus(doc, {
    hasMarkdown: docsWithMarkdown?.has(doc) ?? false,
    hasFailures: docsWithFailures?.has(doc),
    hasCheckpoint: docsWithCheckpoints?.has(doc),
    processing: doc === processingDoc || doc === bulkOp?.currentFile,
  })])), [documents, docsWithMarkdown, docsWithFailures, docsWithCheckpoints, processingDoc, bulkOp?.currentFile])
  const filtered = useMemo(
    () => documents.filter(doc => doc.toLowerCase().includes(search.toLowerCase()) && (statusFilter === 'all' || statuses.get(doc)?.stage === statusFilter)),
    [documents, search, statusFilter, statuses],
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
      if (collapsed || selectMode || keyboardNavigationDisabled || deleting || bulkOp !== null || uploading) return

      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (target?.closest('button') && !target.closest('.doc-name')) return
      if (!selectedDoc || filtered.length === 0) return

      const currentIndex = filtered.indexOf(selectedDoc)
      if (currentIndex === -1) return

      event.preventDefault()
      const nextIndex = event.key === 'ArrowDown'
        ? Math.min(filtered.length - 1, currentIndex + 1)
        : Math.max(0, currentIndex - 1)
      if (nextIndex === currentIndex) return

      onSelect(filtered[nextIndex])
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    filtered,
    selectedDoc,
    onSelect,
    collapsed,
    selectMode,
    keyboardNavigationDisabled,
    deleting,
    bulkOp,
    uploading,
  ])

  useEffect(() => {
    if (!selectedDoc || collapsed) return
    const row = rowRefs.current.get(selectedDoc)
    row?.scrollIntoView({ block: 'nearest' })
    if (document.activeElement?.closest('.doc-name')) {
      row?.querySelector<HTMLButtonElement>('.doc-name')?.focus({ preventScroll: true })
    }
  }, [selectedDoc, collapsed])

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onUpload(files)
    e.target.value = ''
  }

  const acceptFile = (f: File) => /\.(pdf|md)$/i.test(f.name)

  const handleDragEnter = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (uploading) return
    dragDepthRef.current += 1
    setDragOver(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (uploading) {
      e.dataTransfer.dropEffect = 'none'
    } else {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
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

      <input
        ref={fileInputRef}
        type="file"
        id="file-upload"
        accept=".pdf,.md"
        multiple
        onChange={handleFiles}
        hidden
        disabled={uploading}
        aria-label="Upload documents"
      />
      {/* ── Fixed top ── */}
      <div className="sidebar-fixed">

        {collapsed ? (
          <div className="sidebar-brand-collapsed">
            <button
              type="button"
              className="sidebar-collapsed-logo-btn"
              onClick={onToggleCollapse}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              aria-expanded={false}
            >
              <BrandLogo className="sidebar-logo" size={44} />
              <span className="sidebar-logo-hover-icon" aria-hidden="true">
                <IconMenu size={20} />
              </span>
            </button>
          </div>
        ) : (
          <>
            <div className="sidebar-brand">
              <div className="sidebar-brand-main">
                <BrandLogo className="sidebar-logo" />
                <div className="sidebar-brand-meta">
                  <span className="sidebar-app-name">Chunky</span>
                  <span className="sidebar-app-tag">RAG Studio</span>
                </div>
              </div>
              <button
                type="button"
                className="menu-toggle"
                onClick={onToggleCollapse}
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
                aria-expanded={true}
              >
                <IconSidebarCollapse size={18} />
              </button>
            </div>

            <div className="sidebar-upload">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={`upload-btn${dragOver ? ' drag-over' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {uploading ? (
                  <>
                    <IconSpinner size={15} />
                    <span>Uploading…</span>
                  </>
                ) : dragOver ? (
                  <>
                    <IconUpload size={15} />
                    <span>Drop to upload</span>
                  </>
                ) : (
                  <>
                    <IconUpload size={15} />
                    <span>Upload PDF / MD</span>
                  </>
                )}
              </button>
            </div>

            <div className="sidebar-search">
              <IconSearch size={14} className="search-icon" />
              <input
                type="text"
                placeholder="Search documents…"
                aria-label="Search documents"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="search-input"
              />
              {search && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setSearch('')}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  <IconClose size={12} />
                </button>
              )}
            </div>

            {documents.length > 0 && <div className="sidebar-filter">
              <select aria-label="Filter documents by status" value={statusFilter} onChange={e => setStatusFilter(e.target.value as DocumentStage | 'all')}>
                <option value="all">All documents</option>
                <option value="needs-conversion">Needs conversion</option>
                <option value="ready">Markdown ready</option>
                <option value="review">Needs review</option>
                <option value="resume">Resume conversion</option>
                <option value="processing">Processing</option>
              </select>
            </div>}

            <div className="doc-count-row">
              <div className="doc-count-info">
                <span className="sidebar-section-label">Documents</span>
                <span className="doc-count">
                  {filtered.length}{filtered.length !== documents.length ? ` / ${documents.length}` : ''}
                </span>
              </div>
              <div className="doc-count-actions">
              {documents.length > 0 && onExport && !selectMode && (
                <button type="button" className="select-toggle-btn" onClick={() => onExport(documents)} disabled={isBusy}>Export all</button>
              )}
              {documents.length > 0 && (
                <button
                  type="button"
                  className={`select-toggle-btn ${selectMode ? 'active' : ''}`}
                  onClick={toggleSelectMode}
                  title={selectMode ? 'Cancel selection' : 'Select documents'}
                  disabled={isBusy}
                >
                  {selectMode ? 'Cancel' : 'Select'}
                </button>
              )}
              </div>
            </div>

            {selectMode && (
              <>
                <div className="bulk-actions">
                  {onExport && <button type="button" className="bulk-btn" disabled={!visibleSelectedCount || isBusy} onClick={() => onExport(selectedVisible)}><IconDownload size={14} /> Export selected ({visibleSelectedCount})</button>}
                  <button
                    type="button"
                    className="bulk-btn select-all"
                    onClick={toggleSelectAll}
                    disabled={filtered.length === 0 || isBusy}
                  >
                    {allFilteredSelected ? 'Deselect all' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    className="bulk-btn delete-selected"
                    onClick={handleDeleteSelected}
                    disabled={visibleSelectedCount === 0 || isBusy}
                  >
                    {deleting ? (
                      <>
                        <IconSpinner size={14} />
                        <span>Deleting…</span>
                      </>
                    ) : (
                      <>
                        <IconTrash size={14} />
                        <span>Delete{visibleSelectedCount > 0 ? ` (${visibleSelectedCount})` : ''}</span>
                      </>
                    )}
                  </button>
                </div>

                {(onBulkConvert || onBulkChunk || onBulkEnrich || onBulkChunkEnrich) && (
                  <div className="bulk-actions bulk-actions-secondary">
                    {onBulkConvert && (
                      <button
                        type="button"
                        className="bulk-btn convert-selected"
                        onClick={() => runBulkOp('convert', onBulkConvert)}
                        disabled={visibleSelectedCount === 0 || isBusy}
                      >
                        {bulkOp?.type === 'convert' ? (
                          <>
                            <IconSpinner size={14} />
                            <span>{bulkOp.current}/{bulkOp.total}</span>
                          </>
                        ) : (
                          <>
                            <FeatureIcon feature="convert" size={14} />
                            <span>Convert{visibleSelectedCount > 0 ? ` (${visibleSelectedCount})` : ''}</span>
                          </>
                        )}
                      </button>
                    )}
                    {onBulkChunk && (() => {
                      const chunkable = selectedVisible.filter(f => docsWithMarkdown?.has(f)).length
                      return (
                        <button
                          type="button"
                          className="bulk-btn chunk-selected"
                          onClick={() => runBulkOp('chunk', onBulkChunk)}
                          disabled={chunkable === 0 || isBusy}
                          title={visibleSelectedCount > chunkable ? `${visibleSelectedCount - chunkable} visible selected file(s) have no markdown and will be skipped` : undefined}
                        >
                          {bulkOp?.type === 'chunk' ? (
                            <>
                              <IconSpinner size={14} />
                              <span>{bulkOp.current}/{bulkOp.total}</span>
                            </>
                          ) : (
                            <>
                              <FeatureIcon feature="chunk" size={14} />
                              <span>Chunk{chunkable > 0 ? ` (${chunkable})` : ''}</span>
                            </>
                          )}
                        </button>
                      )
                    })()}
                    {onBulkEnrich && (() => {
                      const enrichable = selectedVisible.filter(f => docsWithMarkdown?.has(f)).length
                      return (
                        <button
                          type="button"
                          className="bulk-btn enrich-selected"
                          onClick={() => runBulkOp('enrich', onBulkEnrich)}
                          disabled={enrichable === 0 || isBusy}
                          title={visibleSelectedCount > enrichable ? `${visibleSelectedCount - enrichable} visible selected file(s) have no markdown and will be skipped` : 'Bulk enrichment skips the summary review modal and uses any cached summary silently.'}
                        >
                          {bulkOp?.type === 'enrich' ? (
                            <>
                              <IconSpinner size={14} />
                              <span>{bulkOp.current}/{bulkOp.total}</span>
                            </>
                          ) : (
                            <>
                              <FeatureIcon feature="enrich" size={14} />
                              <span>Enrich MD{enrichable > 0 ? ` (${enrichable})` : ''}</span>
                            </>
                          )}
                        </button>
                      )
                    })()}
                    {onBulkChunkEnrich && (() => {
                      const enrichable = selectedVisible.filter(f => docsWithMarkdown?.has(f)).length
                      return (
                        <button
                          type="button"
                          className="bulk-btn chunk-enrich-selected"
                          onClick={() => runBulkOp('chunk-enrich', onBulkChunkEnrich)}
                          disabled={enrichable === 0 || isBusy}
                          title={visibleSelectedCount > enrichable ? `${visibleSelectedCount - enrichable} visible selected file(s) have no markdown and will be skipped` : 'Enrich saved chunks, or chunk first when no matching saved chunks exist.'}
                        >
                          {bulkOp?.type === 'chunk-enrich' ? (
                            <>
                              <IconSpinner size={14} />
                              <span>{bulkOp.current}/{bulkOp.total}</span>
                            </>
                          ) : (
                            <>
                              <FeatureIcon feature="enrich" size={14} />
                              <span>Enrich Chunks{enrichable > 0 ? ` (${enrichable})` : ''}</span>
                            </>
                          )}
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
              ? <li className="no-docs">{search || statusFilter !== 'all' ? 'No matching documents' : 'Your library is empty. Upload a PDF or Markdown file to begin.'}</li>
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
                      <span className="doc-icon">
                        {doc.toLowerCase().endsWith('.pdf') ? (
                          <IconPdf size={15} className="doc-icon-svg pdf" />
                        ) : doc.toLowerCase().endsWith('.md') ? (
                          <IconMarkdown size={15} className="doc-icon-svg md" />
                        ) : (
                          <IconFile size={15} className="doc-icon-svg" />
                        )}
                      </span>
                      <button
                        type="button"
                        className="doc-name"
                        aria-label={doc}
                        aria-description={statuses.get(doc)?.label}
                        aria-current={isActive ? 'true' : undefined}
                        onClick={e => {
                          e.stopPropagation()
                          selectMode ? toggleDoc(doc, e.shiftKey) : onSelect(doc)
                        }}
                      >
                        <span className="doc-title">{doc}</span>
                        <span className="doc-stage">{statuses.get(doc)?.label}</span>
                      </button>
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
                            <IconWarning size={14} />
                          )}
                        </span>
                      )}
                      {docsWithMarkdown?.has(doc) && (
                        <StatusBadge tone="success" title="Markdown available">MD</StatusBadge>
                      )}
                      {!selectMode && (
                        <button
                          type="button"
                          className="doc-delete-btn"
                          onClick={e => handleDeleteSingle(e, doc)}
                          title={`Delete ${doc}`}
                          aria-label={`Delete ${doc}`}
                          disabled={deleting}
                        >
                          <IconTrash size={13} />
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
            type="button"
            className="sidebar-settings-btn"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <IconSettings size={16} className="sidebar-settings-icon" />
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
