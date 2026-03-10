import { useState } from 'react'
import type { ChunkSettings, ConverterType } from '../../types'
import './SettingsModal.css'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (settings: ChunkSettings) => void
  current: ChunkSettings
}

const CONVERTER_LABELS: Record<ConverterType, string> = {
  pymupdf: 'PyMuPDF',
  docling: 'Docling',
  markitdown: 'MarkItDown',
  vlm: 'VLM',
}

const CONVERTER_DESCRIPTIONS: Record<ConverterType, string> = {
  pymupdf: 'Fast and lightweight. Best for standard digital PDFs.',
  docling: 'Advanced layout understanding. Best for complex documents.',
  markitdown: "Microsoft's converter. Broad format support, simple and reliable.",
  vlm: 'Vision-language model via OpenAI-compatible API. Best quality for complex or scanned PDFs.',
}

const SPLITTER_DESCRIPTIONS: Record<string, string> = {
  token: 'Splits by tokens using tiktoken — best for LLM processing.',
  recursive: 'Recursively splits on paragraphs, sentences, then words.',
  character: 'Splits on paragraph breaks (\\n\\n).',
  markdown: 'Splits on H1 / H2 / H3 headers.',
}

const ALL_CONVERTERS = (['pymupdf', 'docling', 'markitdown', 'vlm'] as ConverterType[])

export default function SettingsModal({ isOpen, onClose, onSave, current }: Props) {
  const [settings, setSettings] = useState<ChunkSettings>(current)

  if (!isOpen) return null

  const isSizeDisabled = settings.splitterType === 'markdown' && !settings.enableMarkdownSizing

  const set = <K extends keyof ChunkSettings>(key: K, value: ChunkSettings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }))

  const setVlm = (key: 'model' | 'base_url' | 'api_key', value: string) =>
    setSettings(prev => ({ ...prev, vlm: { ...prev.vlm, [key]: value || undefined } }))

  const handleOverlay = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleSave = () => {
    onSave(settings)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleOverlay}>
      <div className="settings-modal">

        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className="modal-body">

          {/* ── Conversion ── */}
          <div className="modal-section-title">Markdown Conversion</div>

          <div className="form-group">
            <label>Converter Engine</label>
            <div className="converter-options">
              {ALL_CONVERTERS.map(c => (
                <button
                  key={c}
                  className={`converter-option${settings.converter === c ? ' selected' : ''}`}
                  onClick={() => set('converter', c)}
                >
                  <span className="converter-label">{CONVERTER_LABELS[c]}</span>
                  <span className="converter-desc">{CONVERTER_DESCRIPTIONS[c]}</span>
                </button>
              ))}
            </div>
          </div>

          {/* VLM settings — shown only when vlm is selected */}
          {settings.converter === 'vlm' && (
            <div className="vlm-settings">
              <div className="form-group">
                <label>Model <span className="label-hint">(default: qwen3-vl:4b-instruct-q4_K_M)</span></label>
                <input
                  type="text"
                  placeholder="e.g. llama3.2-vision, gpt-4o, gemini-2.5-flash"
                  value={settings.vlm?.model ?? ''}
                  onChange={e => setVlm('model', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Base URL <span className="label-hint">(default: http://localhost:11434/v1)</span></label>
                <input
                  type="text"
                  placeholder="e.g. https://api.openai.com/v1"
                  value={settings.vlm?.base_url ?? ''}
                  onChange={e => setVlm('base_url', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>API Key <span className="label-hint">(leave empty for Ollama)</span></label>
                <input
                  type="password"
                  placeholder="sk-… / AIza… / (empty for Ollama)"
                  value={settings.vlm?.api_key ?? ''}
                  onChange={e => setVlm('api_key', e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="modal-divider" />

          {/* ── Chunking ── */}
          <div className="modal-section-title">Chunking</div>

          <div className="form-group">
            <label>Splitter Type</label>
            <select
              value={settings.splitterType}
              onChange={e => set('splitterType', e.target.value as ChunkSettings['splitterType'])}
            >
              <option value="token">Token</option>
              <option value="recursive">Recursive Character</option>
              <option value="character">Character</option>
              <option value="markdown">Markdown Header</option>
            </select>
            <small>{SPLITTER_DESCRIPTIONS[settings.splitterType]}</small>
          </div>

          {settings.splitterType === 'markdown' && (
            <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.enableMarkdownSizing}
                  onChange={e => set('enableMarkdownSizing', e.target.checked)}
                />
                Enable size &amp; overlap for markdown splits
              </label>
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label>Chunk Size <span className="label-hint">({settings.splitterType === 'token' ? 'tokens' : 'chars'})</span></label>
              <input
                type="number"
                value={settings.chunkSize}
                onChange={e => set('chunkSize', parseInt(e.target.value))}
                min={100} max={10000} step={100}
                disabled={isSizeDisabled}
              />
            </div>
            <div className="form-group">
              <label>Overlap <span className="label-hint">({settings.splitterType === 'token' ? 'tokens' : 'chars'})</span></label>
              <input
                type="number"
                value={settings.chunkOverlap}
                onChange={e => set('chunkOverlap', parseInt(e.target.value))}
                min={0} max={Math.floor(settings.chunkSize / 2)} step={50}
                disabled={isSizeDisabled}
              />
            </div>
          </div>
          {isSizeDisabled && <small className="size-hint">Enable sizing above to set chunk size and overlap.</small>}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Apply Settings</button>
        </div>
      </div>
    </div>
  )
}