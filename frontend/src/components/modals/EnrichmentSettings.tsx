import type { EnrichmentSettings as EnrichmentSettingsType } from '../../types'

interface Props {
  title: string
  settings: EnrichmentSettingsType | undefined
  onChange: (updated: EnrichmentSettingsType) => void
  defaultPrompt?: string
  variant?: 'section' | 'chunk'
}

export default function EnrichmentSettings({ title, settings, onChange, defaultPrompt, variant = 'section' }: Props) {
  const s = settings ?? {}

  const set = (key: keyof EnrichmentSettingsType, value: string | number | undefined) =>
    onChange({ ...s, [key]: value === '' ? undefined : value })

  return (
    <div className={`enrichment-settings enrichment-settings--${variant}`}>
      <div className="enrichment-settings-title">{title}</div>

      <div className="form-group">
        <label>Model</label>
        <input
          type="text"
          placeholder="e.g. gpt-4o, llama3.1, gemini-2.5-flash"
          value={s.model ?? ''}
          onChange={e => set('model', e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>Base URL <span className="label-hint">(default: http://localhost:11434/v1)</span></label>
        <input
          type="text"
          placeholder="e.g. https://api.openai.com/v1"
          value={s.base_url ?? ''}
          onChange={e => set('base_url', e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>API Key <span className="label-hint">(leave empty for Ollama)</span></label>
        <input
          type="password"
          placeholder="sk-… / AIza… / (empty for Ollama)"
          value={s.api_key ?? ''}
          onChange={e => set('api_key', e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>Temperature <span className="label-hint">(0 = deterministic, 1 = creative, default: 0.3)</span></label>
        <div className="temperature-control">
          <input
            type="range"
            min={0} max={1} step={0.01}
            value={s.temperature ?? 0.3}
            onChange={e => set('temperature', parseFloat(e.target.value))}
          />
          <span className="temperature-value">{(s.temperature ?? 0.3).toFixed(2)}</span>
        </div>
      </div>

      <div className="form-group">
        <label>System Prompt <span className="label-hint">(optional — overrides built-in instructions)</span></label>
        <textarea
          className="enrichment-textarea"
          placeholder={defaultPrompt ?? 'Leave blank to use the built-in system prompt…'}
          value={s.user_prompt ?? defaultPrompt ?? ''}
          onChange={e => set('user_prompt', e.target.value || undefined)}
          rows={4}
        />
      </div>
    </div>
  )
}
