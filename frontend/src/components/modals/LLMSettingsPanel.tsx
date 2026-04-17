import { useState } from 'react'
import type { EnrichmentSettings } from '../../types'

interface Props {
  title?: string
  value: EnrichmentSettings
  onChange: (updated: EnrichmentSettings) => void
  defaultModel?: string
  defaultBaseUrl?: string
  defaultTemperature?: number
  promptLabel?: string
  promptRows?: number
}

/**
 * Shared LLM settings form used by both the VLM conversion section
 * and the two enrichment settings panels (Markdown + Chunk).
 */
export default function LLMSettingsPanel({
  title,
  value,
  onChange,
  defaultModel,
  defaultBaseUrl,
  defaultTemperature = 0.3,
  promptLabel = 'System Prompt',
  promptRows = 4,
}: Props) {
  const [showApiKey, setShowApiKey] = useState(false)

  const set = (key: keyof EnrichmentSettings, v: string | number | undefined) =>
    onChange({ ...value, [key]: v === '' ? undefined : v })

  const temperature = value.temperature ?? defaultTemperature

  return (
    <div className="llm-settings-panel">
      {title && <div className="enrichment-settings-title">{title}</div>}

      <div className="form-group">
        <label>Model</label>
        <input
          type="text"
          placeholder={defaultModel ?? 'e.g. gpt-4o, llama3.1'}
          value={value.model ?? ''}
          onChange={e => set('model', e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>Base URL</label>
        <input
          type="text"
          placeholder={defaultBaseUrl ?? 'e.g. https://api.openai.com/v1'}
          value={value.base_url ?? ''}
          onChange={e => set('base_url', e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>API Key <span className="label-hint">(leave empty for Ollama)</span></label>
        <div className="api-key-wrapper">
          <input
            type={showApiKey ? 'text' : 'password'}
            placeholder="sk-… / AIza… / (empty for Ollama)"
            value={value.api_key ?? ''}
            onChange={e => set('api_key', e.target.value)}
          />
          <button
            type="button"
            className="api-key-toggle"
            onClick={() => setShowApiKey(v => !v)}
            title={showApiKey ? 'Hide API key' : 'Show API key'}
            aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
          >
            {showApiKey ? (
              // eye-off
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            ) : (
              // eye
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>Temperature <span className="label-hint">(0 = deterministic, 1 = creative, default: {defaultTemperature.toFixed(2)})</span></label>
        <div className="temperature-control">
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={temperature}
            onChange={e => set('temperature', parseFloat(e.target.value))}
          />
          <span className="temperature-value">{temperature.toFixed(2)}</span>
        </div>
      </div>

      <div className="form-group">
        <label>{promptLabel} <span className="label-hint">(optional — overrides built-in instructions)</span></label>
        <textarea
          className="enrichment-textarea"
          placeholder="Leave blank to use the built-in system prompt…"
          value={value.user_prompt ?? ''}
          onChange={e => set('user_prompt', e.target.value)}
          rows={promptRows}
        />
      </div>
    </div>
  )
}
