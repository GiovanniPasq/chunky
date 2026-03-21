import { useState, useEffect } from 'react'
import type { Chunk } from '../../types'
import './ChunkEditModal.css'

type TabId = 'content' | 'enrichment'

interface Props {
  isOpen: boolean
  onClose: () => void
  chunkIndex: number
  chunk: Chunk
  onSave: (index: number, content: string, metadataUpdates?: Partial<Chunk>) => void
  totalChunks: number
}

function hasEnrichment(chunk: Chunk): boolean {
  return !!(
    chunk.title ||
    chunk.summary ||
    chunk.context ||
    chunk.cleaned_chunk ||
    chunk.keywords?.length ||
    chunk.questions?.length
  )
}

export default function ChunkEditModal({ isOpen, onClose, chunkIndex, chunk, onSave, totalChunks }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('content')
  const [content, setContent] = useState(chunk.content)
  const [title, setTitle] = useState(chunk.title ?? '')
  const [summary, setSummary] = useState(chunk.summary ?? '')
  const [context, setContext] = useState(chunk.context ?? '')
  const [cleanedChunk, setCleanedChunk] = useState(chunk.cleaned_chunk ?? '')
  const [keywords, setKeywords] = useState((chunk.keywords ?? []).join(', '))
  const [questions, setQuestions] = useState((chunk.questions ?? []).join('\n'))

  useEffect(() => {
    setActiveTab('content')
    setContent(chunk.content)
    setTitle(chunk.title ?? '')
    setSummary(chunk.summary ?? '')
    setContext(chunk.context ?? '')
    setCleanedChunk(chunk.cleaned_chunk ?? '')
    setKeywords((chunk.keywords ?? []).join(', '))
    setQuestions((chunk.questions ?? []).join('\n'))
  }, [chunk])

  if (!isOpen) return null

  const enriched = hasEnrichment(chunk)

  const handleSave = () => {
    const metadataUpdates: Partial<Chunk> = {
      title,
      summary,
      context,
      cleaned_chunk: cleanedChunk,
      keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
      questions: questions.split('\n').map(q => q.trim()).filter(Boolean),
    }
    onSave(chunkIndex, content, metadataUpdates)
    onClose()
  }

  const handleCancel = () => {
    onClose()
  }

  return (
    <div className="chunk-edit-overlay" onClick={handleCancel}>
      <div className="chunk-edit-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="chunk-edit-header">
          <div className="chunk-edit-title-row">
            <h2>Edit Chunk</h2>
            <span className="chunk-edit-badge">
              <span className="chunk-edit-current">{chunkIndex + 1}</span>
              <span className="chunk-edit-sep">/</span>
              <span className="chunk-edit-total">{totalChunks}</span>
            </span>
            {enriched && <span className="chunk-edit-enriched-badge">✓ Enriched</span>}
          </div>
          <button className="chunk-edit-close" onClick={handleCancel}>✕</button>
        </div>

        {/* Tab bar */}
        <div className="chunk-edit-tabs">
          <button
            className={`chunk-edit-tab${activeTab === 'content' ? ' active' : ''}`}
            onClick={() => setActiveTab('content')}
          >
            Content
          </button>
          <button
            className={`chunk-edit-tab${activeTab === 'enrichment' ? ' active' : ''}${enriched ? ' has-data' : ''}`}
            onClick={() => setActiveTab('enrichment')}
          >
            Enrichment
            {enriched && <span className="chunk-edit-tab-dot" />}
          </button>
        </div>

        {/* Body */}
        <div className="chunk-edit-body">

          {/* Content tab */}
          {activeTab === 'content' && (
            <>
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
            </>
          )}

          {/* Enrichment tab */}
          {activeTab === 'enrichment' && (
            <div className="chunk-edit-enrichment">
              {!enriched && (
                <p className="chunk-edit-enrichment-hint">
                  No enrichment data yet. Run the Enrich action on this chunk, or fill in the fields manually.
                </p>
              )}

              <div className="chunk-edit-field">
                <label>Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="Auto-generated title…"
                />
              </div>

              <div className="chunk-edit-field">
                <label>Summary</label>
                <textarea
                  value={summary}
                  onChange={e => setSummary(e.target.value)}
                  placeholder="One-sentence summary…"
                  rows={2}
                />
              </div>

              <div className="chunk-edit-field">
                <label>Context</label>
                <textarea
                  value={context}
                  onChange={e => setContext(e.target.value)}
                  placeholder="Surrounding document context…"
                  rows={3}
                />
              </div>

              <div className="chunk-edit-field">
                <label>Cleaned Chunk</label>
                <textarea
                  className="chunk-edit-mono"
                  value={cleanedChunk}
                  onChange={e => setCleanedChunk(e.target.value)}
                  placeholder="Cleaned / normalised text…"
                  rows={3}
                />
              </div>

              <div className="chunk-edit-field">
                <label>
                  Keywords
                  <span className="chunk-edit-field-hint">comma-separated</span>
                </label>
                <input
                  type="text"
                  value={keywords}
                  onChange={e => setKeywords(e.target.value)}
                  placeholder="keyword1, keyword2, keyword3…"
                />
                {keywords && (
                  <div className="chunk-edit-tag-preview">
                    {keywords.split(',').map(k => k.trim()).filter(Boolean).map((kw, i) => (
                      <span key={i} className="chunk-edit-tag">{kw}</span>
                    ))}
                  </div>
                )}
              </div>

              <div className="chunk-edit-field">
                <label>
                  Questions
                  <span className="chunk-edit-field-hint">one per line</span>
                </label>
                <textarea
                  value={questions}
                  onChange={e => setQuestions(e.target.value)}
                  placeholder="What does this chunk explain?&#10;Which topics are covered here?"
                  rows={4}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="chunk-edit-footer">
          <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save Changes</button>
        </div>

      </div>
    </div>
  )
}
