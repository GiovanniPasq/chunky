import { useState, useEffect } from 'react'
import './ChunkEditModal.css'

interface Props {
  isOpen: boolean
  onClose: () => void
  chunkIndex: number
  chunkContent: string
  onSave: (index: number, content: string) => void
  totalChunks: number
}

export default function ChunkEditModal({ isOpen, onClose, chunkIndex, chunkContent, onSave, totalChunks }: Props) {
  const [content, setContent] = useState(chunkContent)

  useEffect(() => { setContent(chunkContent) }, [chunkContent])

  if (!isOpen) return null

  const handleSave = () => {
    onSave(chunkIndex, content)
    onClose()
  }

  const handleCancel = () => {
    setContent(chunkContent)
    onClose()
  }

  return (
    <div className="chunk-edit-overlay" onClick={handleCancel}>
      <div className="chunk-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="chunk-edit-header">
          <div className="chunk-edit-title-row">
            <h2>Edit Chunk</h2>
            <span className="chunk-edit-badge">
              <span className="chunk-edit-current">{chunkIndex + 1}</span>
              <span className="chunk-edit-sep">/</span>
              <span className="chunk-edit-total">{totalChunks}</span>
            </span>
          </div>
          <button className="chunk-edit-close" onClick={handleCancel}>✕</button>
        </div>
        <div className="chunk-edit-body">
          <textarea
            className="chunk-edit-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Edit chunk content…"
            autoFocus
          />
          <div className="chunk-edit-info">
            <span>{content.length.toLocaleString()} characters</span>
            <span>{content.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words</span>
          </div>
        </div>
        <div className="chunk-edit-footer">
          <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save Changes</button>
        </div>
      </div>
    </div>
  )
}