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
        onChange={onChange}
        defaultModel={DEFAULT_ENRICHMENT_MODEL}
        defaultBaseUrl={DEFAULT_ENRICHMENT_BASE_URL}
        defaultTemperature={DEFAULT_ENRICHMENT_TEMPERATURE}
        promptLabel="System Prompt"
        promptRows={4}
      />
    </div>
  )
}
