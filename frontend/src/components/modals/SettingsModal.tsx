import { useState, useEffect, useCallback } from 'react'
import type { ChunkSettings, Capabilities, CapabilityLibrary, EnrichmentSettings } from '../../types'
import { capabilityService } from '../../services/apiService'
import {
  DEFAULT_SETTINGS,
  DEFAULT_VLM_MODEL,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_TEMPERATURE,
  normaliseChunkSettings,
} from '../../hooks/useSettings'
import EnrichmentSettingsPanel from './EnrichmentSettings'
import LLMSettingsPanel from './LLMSettingsPanel'
import './SettingsModal.css'

// Module-level cache — capabilities never change while the backend is running,
// so we only ever fetch them once per page load.
let capabilitiesCache: Capabilities | null = null

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (settings: ChunkSettings) => void
  current: ChunkSettings
}

type LoadState = 'loading' | 'ok' | 'error'
type TabId = 'conversion' | 'chunking' | 'enrichment'

function strategiesFor(caps: Capabilities, library: string) {
  return caps.chunkers.find(l => l.library === library)?.strategies ?? []
}

function resolveStrategy(caps: Capabilities, library: string, current: string): string {
  const strats = strategiesFor(caps, library)
  return strats.some(s => s.strategy === current) ? current : (strats[0]?.strategy ?? current)
}

// Chunkers that don't support chunk_overlap per Chonkie docs
const CHONKIE_NO_OVERLAP = new Set(['recursive', 'fast', 'table', 'code', 'late', 'neural', 'slumber'])
const CHONKIE_NO_SIZE = new Set(['table', 'neural'])

export default function SettingsModal({ isOpen, onClose, onSave, current }: Props) {
  const [settings, setSettings] = useState<ChunkSettings>(current)
  const [chunkSizeDraft, setChunkSizeDraft] = useState(String(current.chunkSize))
  const [chunkOverlapDraft, setChunkOverlapDraft] = useState(String(current.chunkOverlap))
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [activeTab, setActiveTab] = useState<TabId>('conversion')

  const fetchCaps = useCallback(() => {
    // Serve from cache on subsequent opens — capabilities don't change at runtime.
    if (capabilitiesCache) {
      const data = capabilitiesCache
      setCaps(data)
      setLoadState('ok')
      setSettings(prev => {
        const lib = data.chunkers.some(l => l.library === prev.chunkerLibrary)
          ? prev.chunkerLibrary
          : (data.chunkers[0]?.library ?? prev.chunkerLibrary)
        const strategy = resolveStrategy(data, lib, prev.chunkerType)
        const converter = data.converters.some(c => c.name === prev.converter)
          ? prev.converter
          : (data.converters[0]?.name ?? prev.converter)
        return { ...prev, chunkerLibrary: lib, chunkerType: strategy, converter }
      })
      return
    }
    setLoadState('loading')
    setCaps(null)
    capabilityService.get()
      .then(data => {
        capabilitiesCache = data
        setCaps(data)
        setLoadState('ok')
        setSettings(prev => {
          const lib = data.chunkers.some(l => l.library === prev.chunkerLibrary)
            ? prev.chunkerLibrary
            : (data.chunkers[0]?.library ?? prev.chunkerLibrary)
          const strategy = resolveStrategy(data, lib, prev.chunkerType)
          const converter = data.converters.some(c => c.name === prev.converter)
            ? prev.converter
            : (data.converters[0]?.name ?? prev.converter)
          return { ...prev, chunkerLibrary: lib, chunkerType: strategy, converter }
        })
      })
      .catch(() => setLoadState('error'))
  }, [])

  useEffect(() => {
    if (isOpen) fetchCaps()
  }, [isOpen, fetchCaps])

  useEffect(() => {
    if (!isOpen) setSettings(current)
  }, [current, isOpen])

  useEffect(() => {
    setChunkSizeDraft(String(settings.chunkSize))
    setChunkOverlapDraft(String(settings.chunkOverlap))
  }, [settings.chunkSize, settings.chunkOverlap])

  if (!isOpen) return null

  const set = <K extends keyof ChunkSettings>(key: K, value: ChunkSettings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }))

  const setCloud = (key: 'base_url' | 'bearer_token', value: string) =>
    setSettings(prev => ({ ...prev, cloud: { ...prev.cloud, [key]: value || undefined } }))

  const setSectionEnrichment = (updated: EnrichmentSettings) =>
    setSettings(prev => ({ ...prev, sectionEnrichment: updated }))

  const setChunkEnrichment = (updated: EnrichmentSettings) =>
    setSettings(prev => ({ ...prev, chunkEnrichment: updated }))

  const handleLibraryChange = (lib: string) => {
    if (!caps) return
    const strategy = resolveStrategy(caps, lib, settings.chunkerType)
    setSettings(prev => ({ ...prev, chunkerLibrary: lib, chunkerType: strategy }))
  }

  const handleOverlay = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleSave = () => {
    onSave(normaliseChunkSettings(settings))
    onClose()
  }

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS)
    setChunkSizeDraft(String(DEFAULT_SETTINGS.chunkSize))
    setChunkOverlapDraft(String(DEFAULT_SETTINGS.chunkOverlap))
  }

  const handleChunkSizeChange = (value: string) => {
    setChunkSizeDraft(value)
    if (value.trim() === '') return
    const v = parseInt(value, 10)
    if (!Number.isNaN(v)) set('chunkSize', v)
  }

  const handleChunkOverlapChange = (value: string) => {
    setChunkOverlapDraft(value)
    if (value.trim() === '') return
    const v = parseInt(value, 10)
    if (!Number.isNaN(v)) set('chunkOverlap', v)
  }

  const availableStrategies = caps ? strategiesFor(caps, settings.chunkerLibrary) : []
  const currentStrategy = availableStrategies.find(s => s.strategy === settings.chunkerType)

  const isDocling = settings.chunkerLibrary === 'docling'
  const isMarkdownSizeDisabled =
    settings.chunkerType === 'markdown' && !settings.enableMarkdownSizing
  const isChunkerSizeDisabled =
    settings.chunkerLibrary === 'chonkie' && CHONKIE_NO_SIZE.has(settings.chunkerType)
  const isSizeDisabled = isMarkdownSizeDisabled || isChunkerSizeDisabled
  const isOverlapDisabled =
    isSizeDisabled ||
    isDocling ||
    (settings.chunkerLibrary === 'chonkie' && CHONKIE_NO_OVERLAP.has(settings.chunkerType))
  const sizeUnit = isDocling || settings.chunkerType === 'token'
    ? 'tokens'
    : settings.chunkerLibrary === 'chonkie' && settings.chunkerType === 'fast'
      ? 'bytes'
      : 'chars'

  return (
    <div className="modal-overlay" onClick={handleOverlay}>
      <div className="settings-modal">

        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Loading state */}
        {loadState === 'loading' && (
          <div className="caps-state caps-loading">
            <div className="caps-spinner" />
            <p>Loading configuration…</p>
          </div>
        )}

        {/* Error state */}
        {loadState === 'error' && (
          <div className="caps-state caps-error">
            <span className="caps-error-icon">⚠️</span>
            <p>Could not reach the server.<br />Check that the backend is running.</p>
            <button className="btn-retry" onClick={fetchCaps}>↺ Retry</button>
          </div>
        )}

        {/* Body — only shown when caps loaded */}
        {loadState === 'ok' && caps && (
          <>
            {/* Tab bar */}
            <div className="settings-tabs">
              <button
                className={`settings-tab${activeTab === 'conversion' ? ' active' : ''}`}
                onClick={() => setActiveTab('conversion')}
              >
                Conversion
              </button>
              <button
                className={`settings-tab${activeTab === 'chunking' ? ' active' : ''}`}
                onClick={() => setActiveTab('chunking')}
              >
                Chunking
              </button>
              <button
                className={`settings-tab${activeTab === 'enrichment' ? ' active' : ''}`}
                onClick={() => setActiveTab('enrichment')}
              >
                Enrichment
              </button>
            </div>

            <div className="modal-body">

              {/* ── Tab 1: Markdown Conversion ── */}
              {activeTab === 'conversion' && (
                <>
                  <div className="modal-section-title">Converter Engine</div>

                  <div className="form-group">
                    <div className="converter-options">
                      {caps.converters.map(c => (
                        <button
                          key={c.name}
                          className={`converter-option${settings.converter === c.name ? ' selected' : ''}`}
                          onClick={() => set('converter', c.name)}
                        >
                          <span className="converter-label">{c.label}</span>
                          <span className="converter-desc">{c.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {settings.converter === 'cloud' && (
                    <div className="vlm-settings">
                      <div className="form-group">
                        <label>Endpoint URL</label>
                        <input
                          type="text"
                          placeholder="e.g. https://my-api.example.com/convert"
                          value={settings.cloud?.base_url ?? ''}
                          onChange={e => setCloud('base_url', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>Bearer Token <span className="label-hint">(optional)</span></label>
                        <input
                          type="password"
                          placeholder="Leave empty if the endpoint requires no auth"
                          value={settings.cloud?.bearer_token ?? ''}
                          onChange={e => setCloud('bearer_token', e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  {settings.converter === 'vlm' && (
                    <div className="vlm-settings">
                      <LLMSettingsPanel
                        value={settings.vlm ?? {}}
                        onChange={vlm => setSettings(prev => ({ ...prev, vlm: { ...prev.vlm, ...vlm } }))}
                        defaultModel={DEFAULT_VLM_MODEL}
                        defaultBaseUrl={DEFAULT_VLM_BASE_URL}
                        defaultTemperature={DEFAULT_VLM_TEMPERATURE}
                        promptLabel="Prompt"
                        promptRows={5}
                      />

                      <div className="form-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={settings.vlm?.use_checkpoint ?? true}
                            onChange={e => setSettings(prev => ({
                              ...prev,
                              vlm: { ...prev.vlm, use_checkpoint: e.target.checked },
                            }))}
                          />
                          <span>
                            Resume from checkpoint if available
                            <span className="label-hint">
                              {' '}— picks up an interrupted conversion at the last cached page.
                              Uncheck to discard the checkpoint and reconvert from page 1.
                            </span>
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ── Tab 2: Chunking ── */}
              {activeTab === 'chunking' && (
                <>
                  <div className="modal-section-title">Chunking</div>

                  <div className="form-group">
                    <label>Chunker Library</label>
                    <div className="library-toggle">
                      {caps.chunkers.map((lib: CapabilityLibrary) => (
                        <button
                          key={lib.library}
                          className={`library-option${settings.chunkerLibrary === lib.library ? ' selected' : ''}`}
                          onClick={() => handleLibraryChange(lib.library)}
                        >
                          <span className="library-label">{lib.label}</span>
                          <span className="library-desc">{lib.strategies.length} strategies available</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Chunker Type</label>
                    <select
                      value={settings.chunkerType}
                      onChange={e => set('chunkerType', e.target.value)}
                    >
                      {availableStrategies.map(s => (
                        <option key={s.strategy} value={s.strategy}>{s.label}</option>
                      ))}
                    </select>
                    {currentStrategy && <small>{currentStrategy.description}</small>}
                  </div>

                  {settings.chunkerType === 'markdown' && (
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
                      <label>Chunk Size <span className="label-hint">({sizeUnit})</span></label>
                      <input
                        type="number"
                        value={chunkSizeDraft}
                        onChange={e => handleChunkSizeChange(e.target.value)}
                        min={100} max={10000} step={100}
                        disabled={isSizeDisabled}
                      />
                    </div>
                    <div className="form-group">
                      <label>Overlap <span className="label-hint">({sizeUnit})</span></label>
                      <input
                        type="number"
                        value={chunkOverlapDraft}
                        onChange={e => handleChunkOverlapChange(e.target.value)}
                        min={0} max={Math.floor(settings.chunkSize / 2)} step={50}
                        disabled={isOverlapDisabled}
                      />
                    </div>
                  </div>

                  {isMarkdownSizeDisabled && (
                    <small className="size-hint">Enable sizing above to set chunk size and overlap.</small>
                  )}
                  {isChunkerSizeDisabled && (
                    <small className="size-hint">This chunker determines its own boundaries and does not use size or overlap.</small>
                  )}
                  {!isSizeDisabled && isOverlapDisabled && (
                    <small className="size-hint">This chunker does not support chunk overlap.</small>
                  )}

                  <div className="form-group checkbox-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={settings.useFirstMarkdownForBulkChunks}
                        onChange={e => set('useFirstMarkdownForBulkChunks', e.target.checked)}
                      />
                      Use first available Markdown for bulk chunking
                    </label>
                    <small>
                      When disabled, bulk chunking and bulk chunk enrichment use the Markdown
                      variant matching the selected converter.
                    </small>
                  </div>
                </>
              )}

              {/* ── Tab 3: Enrichment ── */}
              {activeTab === 'enrichment' && (
                <>
                  <EnrichmentSettingsPanel
                    title="Markdown Enrichment"
                    settings={settings.sectionEnrichment}
                    onChange={setSectionEnrichment}
                    variant="section"
                  />

                  <div className="modal-divider" />

                  <EnrichmentSettingsPanel
                    title="Chunk Enrichment"
                    settings={settings.chunkEnrichment}
                    onChange={setChunkEnrichment}
                    variant="chunk"
                  />
                </>
              )}
            </div>

            {/* Footer */}
            <div className="modal-footer">
              <button className="btn-reset" onClick={handleReset}>Reset to defaults</button>
              <div className="modal-footer-actions">
                <button className="btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn-primary" onClick={handleSave}>Apply Settings</button>
              </div>
            </div>
          </>
        )}

      </div>
    </div>
  )
}
