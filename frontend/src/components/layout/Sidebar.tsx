import { useState, useRef } from 'react'
import './Sidebar.css'

interface Props {
  documents: string[]
  selectedDoc: string | null
  onSelect: (doc: string) => void
  onUpload: (files: File[]) => void
  uploading: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  onDelete: (filenames: string[]) => Promise<void>
}

export default function Sidebar({
  documents, selectedDoc, onSelect, onUpload, uploading,
  collapsed, onToggleCollapse, onDelete,
}: Props) {
  const [search, setSearch] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filtered = documents.filter(d => d.toLowerCase().includes(search.toLowerCase()))

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onUpload(files)
    e.target.value = ''
  }

  const toggleSelectMode = () => {
    setSelectMode(v => !v)
    setSelected(new Set())
  }

  const toggleDoc = (doc: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(doc) ? next.delete(doc) : next.add(doc)
      return next
    })
  }

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return
    setDeleting(true)
    try {
      await onDelete(Array.from(selected))
      setSelected(new Set())
      setSelectMode(false)
    } finally {
      setDeleting(false)
    }
  }

  const handleDeleteSingle = async (e: React.MouseEvent, doc: string) => {
    e.stopPropagation()
    setDeleting(true)
    try {
      await onDelete([doc])
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>

      {/* ── Fixed top ── */}
      <div className="sidebar-fixed">

        <div className="sidebar-brand">
          <img src="./src/assets/logo.png" alt="Chunky logo" className="sidebar-logo" />
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
              <label htmlFor="file-upload" className="upload-btn">
                {uploading
                  ? <><span>⏳</span> Uploading…</>
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
                >
                  {selectMode ? '✕' : 'Select'}
                </button>
              )}
            </div>

            {selectMode && (
              <div className="bulk-actions">
                <button
                  className="bulk-btn select-all"
                  onClick={() => setSelected(new Set(filtered))}
                  disabled={selected.size === filtered.length}
                >
                  Select all
                </button>
                <button
                  className="bulk-btn delete-selected"
                  onClick={handleDeleteSelected}
                  disabled={selected.size === 0 || deleting}
                >
                  {deleting
                    ? '⏳ Deleting…'
                    : `🗑 Delete${selected.size > 0 ? ` (${selected.size})` : ''}`}
                </button>
              </div>
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
                  const isActive = selectedDoc === doc && !selectMode
                  return (
                    <li
                      key={doc}
                      className={[
                        isActive ? 'active' : '',
                        selectMode && isSelected ? 'selected' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => selectMode ? toggleDoc(doc) : onSelect(doc)}
                      title={doc}
                    >
                      {selectMode && (
                        <span className={`doc-checkbox ${isSelected ? 'checked' : ''}`} />
                      )}
                      <span className="doc-icon">📄</span>
                      <span className="doc-name">{doc}</span>
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
        </div>
      )}
    </div>
  )
}