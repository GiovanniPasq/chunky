import { useState, useEffect, useCallback } from 'react'
import type { ChunkSettings, Capabilities, CapabilityLibrary, EnrichmentSettings } from '../../types'
import { capabilityService } from '../../services/apiService'
import { DEFAULT_SETTINGS, DEFAULT_VLM_PROMPT, DEFAULT_SECTION_PROMPT, DEFAULT_CHUNK_PROMPT, DEFAULT_VLM_MODEL, DEFAULT_VLM_BASE_URL, DEFAULT_VLM_TEMPERATURE } from '../../hooks/useSettings'
import EnrichmentSettingsPanel from './EnrichmentSettings'
import './SettingsModal.css'

// Module-level cache — capabilities never change while the backend is running,
// so we only ever fetch them once per page load.
let capabilitiesCache: Capabilities | null = null

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (settings: ChunkSettings) => void
  onReset?: () => void
  current: ChunkSettings
}

type LoadState = 'loading' | 'ok' | 'error'
type TabId = 'conversion' | 'chunking' | 'enrichment'

function strategiesFor(caps: Capabilities, library: string) {
  return caps.splitters.find(l => l.library === library)?.strategies ?? []
}

function resolveStrategy(caps: Capabilities, library: string, current: string): string {
  const strats = strategiesFor(caps, library)
  return strats.some(s => s.strategy === current) ? current : (strats[0]?.strategy ?? current)
}

// Chunkers that don't support chunk_overlap per Chonkie docs
const CHONKIE_NO_OVERLAP = new Set(['recursive', 'fast', 'table', 'code', 'late', 'neural', 'slumber'])

export default function SettingsModal({ isOpen, onClose, onSave, onReset, current }: Props) {
  const [settings, setSettings] = useState<ChunkSettings>(current)
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
        const lib = data.splitters.some(l => l.library === prev.splitterLibrary)
          ? prev.splitterLibrary
          : (data.splitters[0]?.library ?? prev.splitterLibrary)
        const strategy = resolveStrategy(data, lib, prev.splitterType)
        const converter = data.converters.some(c => c.name === prev.converter)
          ? prev.converter
          : (data.converters[0]?.name ?? prev.converter)
        return { ...prev, splitterLibrary: lib, splitterType: strategy, converter }
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
          const lib = data.splitters.some(l => l.library === prev.splitterLibrary)
            ? prev.splitterLibrary
            : (data.splitters[0]?.library ?? prev.splitterLibrary)
          const strategy = resolveStrategy(data, lib, prev.splitterType)
          const converter = data.converters.some(c => c.name === prev.converter)
            ? prev.converter
            : (data.converters[0]?.name ?? prev.converter)
          return { ...prev, splitterLibrary: lib, splitterType: strategy, converter }
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

  if (!isOpen) return null

  const set = <K extends keyof ChunkSettings>(key: K, value: ChunkSettings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }))

  const setVlm = (key: 'model' | 'base_url' | 'api_key', value: string) =>
    setSettings(prev => ({ ...prev, vlm: { ...prev.vlm, [key]: value || undefined } }))

  const setVlmTemperature = (value: number) =>
    setSettings(prev => ({ ...prev, vlm: { ...prev.vlm, temperature: value } }))

  const setVlmUserPrompt = (value: string) =>
    setSettings(prev => ({ ...prev, vlm: { ...prev.vlm, user_prompt: value || undefined } }))

  const setCloud = (key: 'base_url' | 'bearer_token', value: string) =>
    setSettings(prev => ({ ...prev, cloud: { ...prev.cloud, [key]: value || undefined } }))

  const setSectionEnrichment = (updated: EnrichmentSettings) =>
    setSettings(prev => ({ ...prev, sectionEnrichment: updated }))

  const setChunkEnrichment = (updated: EnrichmentSettings) =>
    setSettings(prev => ({ ...prev, chunkEnrichment: updated }))

  const handleLibraryChange = (lib: string) => {
    if (!caps) return
    const strategy = resolveStrategy(caps, lib, settings.splitterType)
    setSettings(prev => ({ ...prev, splitterLibrary: lib, splitterType: strategy }))
  }

  const handleOverlay = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  const handleSave = () => {
    onSave(settings)
    onClose()
  }

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS)
    onReset?.()
  }

  const availableStrategies = caps ? strategiesFor(caps, settings.splitterLibrary) : []
  const currentStrategy = availableStrategies.find(s => s.strategy === settings.splitterType)

  const isSizeDisabled = settings.splitterType === 'markdown' && !settings.enableMarkdownSizing
  const isOverlapDisabled =
    isSizeDisabled ||
    (settings.splitterLibrary === 'chonkie' && CHONKIE_NO_OVERLAP.has(settings.splitterType))

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
                      <div className="form-group">
                        <label>Model</label>
                        <input
                          type="text"
                          placeholder={DEFAULT_VLM_MODEL}
                          value={settings.vlm?.model ?? DEFAULT_VLM_MODEL}
                          onChange={e => setVlm('model', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>Base URL</label>
                        <input
                          type="text"
                          placeholder={DEFAULT_VLM_BASE_URL}
                          value={settings.vlm?.base_url ?? DEFAULT_VLM_BASE_URL}
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
                      <div className="form-group">
                        <label>Temperature <span className="label-hint">(0 = deterministic, 1 = creative)</span></label>
                        <div className="temperature-control">
                          <input
                            type="range"
                            min={0} max={1} step={0.01}
                            value={settings.vlm?.temperature ?? DEFAULT_VLM_TEMPERATURE}
                            onChange={e => setVlmTemperature(parseFloat(e.target.value))}
                          />
                          <span className="temperature-value">{(settings.vlm?.temperature ?? DEFAULT_VLM_TEMPERATURE).toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="form-group">
                        <label>Prompt <span className="label-hint">(optional — overrides built-in conversion instructions)</span></label>
                        <textarea
                          className="enrichment-textarea"
                          placeholder={DEFAULT_VLM_PROMPT}
                          value={settings.vlm?.user_prompt ?? DEFAULT_VLM_PROMPT}
                          onChange={e => setVlmUserPrompt(e.target.value)}
                          rows={5}
                        />
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
                    <label>Splitter Library</label>
                    <div className="library-toggle">
                      {caps.splitters.map((lib: CapabilityLibrary) => (
                        <button
                          key={lib.library}
                          className={`library-option${settings.splitterLibrary === lib.library ? ' selected' : ''}`}
                          onClick={() => handleLibraryChange(lib.library)}
                        >
                          <span className="library-label">{lib.label}</span>
                          <span className="library-desc">{lib.strategies.length} strategies available</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Splitter Type</label>
                    <select
                      value={settings.splitterType}
                      onChange={e => set('splitterType', e.target.value)}
                    >
                      {availableStrategies.map(s => (
                        <option key={s.strategy} value={s.strategy}>{s.label}</option>
                      ))}
                    </select>
                    {currentStrategy && <small>{currentStrategy.description}</small>}
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
                        onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) set('chunkSize', v) }}
                        min={100} max={10000} step={100}
                        disabled={isSizeDisabled}
                      />
                    </div>
                    <div className="form-group">
                      <label>Overlap <span className="label-hint">({settings.splitterType === 'token' ? 'tokens' : 'chars'})</span></label>
                      <input
                        type="number"
                        value={settings.chunkOverlap}
                        onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) set('chunkOverlap', v) }}
                        min={0} max={Math.floor(settings.chunkSize / 2)} step={50}
                        disabled={isOverlapDisabled}
                      />
                    </div>
                  </div>

                  {isSizeDisabled && (
                    <small className="size-hint">Enable sizing above to set chunk size and overlap.</small>
                  )}
                  {!isSizeDisabled && isOverlapDisabled && (
                    <small className="size-hint">This chunker does not support chunk overlap.</small>
                  )}
                </>
              )}

              {/* ── Tab 3: Enrichment ── */}
              {activeTab === 'enrichment' && (
                <>
                  <EnrichmentSettingsPanel
                    title="Markdown Enrichment"
                    settings={settings.sectionEnrichment}
                    onChange={setSectionEnrichment}
                    defaultPrompt={DEFAULT_SECTION_PROMPT}
                    variant="section"
                  />

                  <div className="modal-divider" />

                  <EnrichmentSettingsPanel
                    title="Chunk Enrichment"
                    settings={settings.chunkEnrichment}
                    onChange={setChunkEnrichment}
                    defaultPrompt={DEFAULT_CHUNK_PROMPT}
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
