import { IconWarning } from '../common/Icons'
import FeatureIcon from '../common/FeatureIcon'
import Modal from '../common/Modal'
import Button from '../common/Button'
import ViewTabs from '../common/ViewTabs'
import { useState, useEffect } from 'react'
import type { ChunkSettings, Capabilities, CapabilityLibrary, EnrichmentSettings } from '../../types'
import { useCapabilities } from '../../hooks/useCapabilities'
import {
  DEFAULT_SETTINGS,
  DEFAULT_VLM_MODEL,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_TEMPERATURE,
  normaliseChunkSettings,
} from '../../hooks/useSettings'
import EnrichmentSettingsPanel from './EnrichmentSettings'
import LLMSettingsPanel from './LLMSettingsPanel'
import { chunkingOptions } from '../../utils/chunkingOptions'
import './SettingsModal.css'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSave: (settings: ChunkSettings) => void
  current: ChunkSettings
  hasActiveDocument?: boolean
  initialTab?: TabId
}

type TabId = 'conversion' | 'chunking' | 'enrichment'

function strategiesFor(caps: Capabilities, library: string) {
  return caps.chunkers.find(l => l.library === library)?.strategies ?? []
}

function resolveStrategy(caps: Capabilities, library: string, current: string): string {
  const strats = strategiesFor(caps, library)
  return strats.some(s => s.strategy === current) ? current : (strats[0]?.strategy ?? current)
}

export default function SettingsModal({ isOpen, onClose, onSave, current, hasActiveDocument = false, initialTab = 'conversion' }: Props) {
  const [settings, setSettings] = useState<ChunkSettings>(current)
  const [chunkSizeDraft, setChunkSizeDraft] = useState(String(current.chunkSize))
  const [chunkOverlapDraft, setChunkOverlapDraft] = useState(String(current.chunkOverlap))
  const { caps, loadState, retry: fetchCaps } = useCapabilities(isOpen)
  const [activeTab, setActiveTab] = useState<TabId>(initialTab)

  useEffect(() => {
    if (isOpen) setActiveTab(initialTab)
  }, [isOpen, initialTab])

  useEffect(() => {
    if (!isOpen || !caps) return
    setSettings(prev => {
      const lib = caps.chunkers.some(item => item.library === prev.chunkerLibrary)
        ? prev.chunkerLibrary
        : (caps.chunkers[0]?.library ?? prev.chunkerLibrary)
      const strategy = resolveStrategy(caps, lib, prev.chunkerType)
      const converter = caps.converters.some(item => item.name === prev.converter)
        ? prev.converter
        : (caps.converters[0]?.name ?? prev.converter)
      return { ...prev, chunkerLibrary: lib, chunkerType: strategy, converter }
    })
  }, [isOpen, caps])

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

  const isMarkdownSizeDisabled =
    settings.chunkerType === 'markdown' && !settings.enableMarkdownSizing
  const { usesSize, usesOverlap, unit: sizeUnit } = chunkingOptions(settings)
  const isTable = settings.chunkerLibrary === 'chonkie' && settings.chunkerType === 'table'
  const isChunkerSizeDisabled =
    settings.chunkerLibrary === 'chonkie' && !usesSize

  return (
    <Modal open={isOpen} onClose={onClose} title="Settings" className="settings-modal">
      <div className="settings-scope">
        <strong>Saved in this browser for future processing.</strong> Changing the converter does not reconvert files.
        {hasActiveDocument && ' Changing chunking settings regenerates chunks when the Chunks view is open. You will be asked to save or discard any unsaved edits first.'}
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
            <span className="caps-error-icon"><IconWarning size={32} /></span>
            <p>Could not reach the server.<br />Check that the backend is running.</p>
            <button className="btn-retry" onClick={fetchCaps}>Retry</button>
          </div>
        )}

        {/* Body — only shown when caps loaded */}
        {loadState === 'ok' && caps && (
          <>
            {/* Tab bar */}
            <ViewTabs label="Settings section" value={activeTab} onChange={setActiveTab} variant="segmented" className="settings-tabs" items={[
              { value: 'conversion', label: 'Conversion', icon: <FeatureIcon feature="convert" size={13} /> },
              { value: 'chunking', label: 'Chunking', icon: <FeatureIcon feature="chunk" size={13} /> },
              { value: 'enrichment', label: 'Enrichment', icon: <FeatureIcon feature="enrich" size={13} /> },
            ]} />

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
                          aria-pressed={settings.converter === c.name}
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
                          aria-pressed={settings.chunkerLibrary === lib.library}
                          onClick={() => handleLibraryChange(lib.library)}
                        >
                          <span className="library-label">{lib.label}</span>
                          <span className="library-desc">{lib.strategies.length} strategies available</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="chunker-type">Chunker Type</label>
                    <select
                      id="chunker-type"
                      aria-describedby={currentStrategy ? 'chunker-type-description' : undefined}
                      value={settings.chunkerType}
                      onChange={e => set('chunkerType', e.target.value)}
                    >
                      {availableStrategies.map(s => (
                        <option key={s.strategy} value={s.strategy}>{s.label}</option>
                      ))}
                    </select>
                    {currentStrategy && <small id="chunker-type-description">{currentStrategy.description}</small>}
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
                      <label htmlFor="chunk-size">Chunk Size {(usesSize || isTable) && <span className="label-hint">({sizeUnit})</span>}</label>
                      <input
                        id="chunk-size"
                        type="number"
                        value={usesSize ? chunkSizeDraft : isTable ? '3' : ''}
                        placeholder="Not used"
                        onChange={e => handleChunkSizeChange(e.target.value)}
                        min={100} max={10000} step={100}
                        disabled={!usesSize}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="chunk-overlap">Overlap {usesOverlap && <span className="label-hint">({sizeUnit})</span>}</label>
                      <input
                        id="chunk-overlap"
                        type="number"
                        value={usesOverlap ? chunkOverlapDraft : ''}
                        placeholder="Not used"
                        onChange={e => handleChunkOverlapChange(e.target.value)}
                        min={0} max={Math.floor(settings.chunkSize / 2)} step={50}
                        disabled={!usesOverlap}
                      />
                    </div>
                  </div>

                  {isMarkdownSizeDisabled && (
                    <small className="size-hint">Enable sizing above to set chunk size and overlap.</small>
                  )}
                  {isChunkerSizeDisabled && (
                    <small className="size-hint">{isTable ? 'Tables use 3 data rows per chunk with repeated headers. Size and overlap settings are not used.' : 'This chunker determines its own boundaries and does not use size or overlap.'}</small>
                  )}
                  {usesSize && !usesOverlap && (
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
                <Button size="md" onClick={onClose}>Cancel</Button>
                <Button size="md" variant="primary" onClick={handleSave}>Apply settings</Button>
              </div>
            </div>
          </>
        )}

    </Modal>
  )
}
