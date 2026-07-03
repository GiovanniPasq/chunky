import type { EnrichmentSettings as EnrichmentSettingsType } from '../../types'
import {
  DEFAULT_ENRICHMENT_MODEL,
  DEFAULT_ENRICHMENT_BASE_URL,
  DEFAULT_ENRICHMENT_TEMPERATURE,
} from '../../hooks/useSettings'
import LLMSettingsPanel from './LLMSettingsPanel'

interface Props {
  title: string
  settings: EnrichmentSettingsType | undefined
  onChange: (updated: EnrichmentSettingsType) => void
  variant?: 'section' | 'chunk'
}

export default function EnrichmentSettings({ title, settings, onChange, variant = 'section' }: Props) {
  return (
    <div className={`enrichment-settings enrichment-settings--${variant}`}>
      <LLMSettingsPanel
        title={title}
        value={settings ?? {}}
        onChange={updated => onChange({ ...(settings ?? {}), ...updated })}
        defaultModel={DEFAULT_ENRICHMENT_MODEL}
        defaultBaseUrl={DEFAULT_ENRICHMENT_BASE_URL}
        defaultTemperature={DEFAULT_ENRICHMENT_TEMPERATURE}
        promptLabel="System Prompt"
        promptRows={4}
      />

      {/* The per-piece checkpoint is exclusive to the markdown
          enrichment pipeline — chunk enrichment doesn't use it.
          Surfacing the toggle in the chunk panel would just be a no-op
          control, so we render it for the section variant only.  The
          document-summary lifecycle (view / edit / regenerate) lives in
          the Summary Review modal that opens when the user clicks
          Enrich — no setting required here. */}
      {variant === 'section' && (
        <>
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings?.use_checkpoint ?? true}
                onChange={e => onChange({ ...(settings ?? {}), use_checkpoint: e.target.checked })}
              />
              <span>
                Resume from checkpoint if available
                <span className="label-hint">
                  {' '}— re-runs reuse cached per-piece corrections when the inputs are unchanged.
                  Uncheck to discard the cache and re-correct every piece from scratch.
                </span>
              </span>
            </label>
          </div>
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={settings?.skip_summary ?? false}
                onChange={e => onChange({ ...(settings ?? {}), skip_summary: e.target.checked })}
              />
              <span>
                Skip document summary
                <span className="label-hint">
                  {' '}— bypass the Summary Review modal entirely and run enrichment without
                  a document-level reference block. This avoids summary generation at the
                  cost of cross-section context. You can still build a summary
                  later by unchecking this and clicking Enrich.
                </span>
              </span>
            </label>
          </div>
        </>
      )}
    </div>
  )
}
