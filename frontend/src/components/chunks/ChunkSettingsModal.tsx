import { useState } from 'react'
import type { ChunkSettings } from '../../types'
import './ChunkSettingsModal.css'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (settings: ChunkSettings) => void
  current: ChunkSettings
}

const SPLITTER_DESCRIPTIONS: Record<string, string> = {
  token: 'Splits by tokens using tiktoken — best for LLM processing.',
  recursive: 'Recursively splits on paragraphs, sentences, then words.',
  character: 'Splits on paragraph breaks (\\n\\n).',
  markdown: 'Splits on H1 / H2 / H3 headers.',
}

export default function ChunkSettingsModal({ isOpen, onClose, onSave, current }: Props) {
  const [settings, setSettings] = useState<ChunkSettings>(current)

  if (!isOpen) return null

  const isSizeDisabled = settings.splitterType === 'markdown' && !settings.enableMarkdownSizing

  const set = <K extends keyof ChunkSettings>(key: K, value: ChunkSettings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }))

  const handleOverlay = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleSave = () => {
    onSave(settings)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleOverlay}>
      <div className="modal">
        <div className="modal-header">
          <h2>Chunk Settings</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label>Splitter Type</label>
            <select value={settings.splitterType} onChange={e => set('splitterType', e.target.value as ChunkSettings['splitterType'])}>
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
                Enable size & overlap for markdown splits
              </label>
            </div>
          )}

          <div className="form-group">
            <label>Chunk Size ({settings.splitterType === 'token' ? 'tokens' : 'chars'})</label>
            <input
              type="number"
              value={settings.chunkSize}
              onChange={e => set('chunkSize', parseInt(e.target.value))}
              min={100} max={10000} step={100}
              disabled={isSizeDisabled}
            />
            {isSizeDisabled && <small>Enable sizing above to set chunk size.</small>}
          </div>

          <div className="form-group">
            <label>Chunk Overlap ({settings.splitterType === 'token' ? 'tokens' : 'chars'})</label>
            <input
              type="number"
              value={settings.chunkOverlap}
              onChange={e => set('chunkOverlap', parseInt(e.target.value))}
              min={0} max={Math.floor(settings.chunkSize / 2)} step={50}
              disabled={isSizeDisabled}
            />
          </div>

          <div className="modal-preview">
            <strong>Preview</strong>
            <p>
              Type: <b>{settings.splitterType}</b> &nbsp;·&nbsp;
              Size: <b>{settings.chunkSize}</b> &nbsp;·&nbsp;
              Overlap: <b>{settings.chunkOverlap}</b>
            </p>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Apply Settings</button>
        </div>
      </div>
    </div>
  )
}
