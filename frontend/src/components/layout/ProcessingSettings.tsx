import type { ChunkSettings } from '../../types'
import { useCapabilities } from '../../hooks/useCapabilities'
import { chunkingOptions } from '../../utils/chunkingOptions'
import FeatureIcon from '../common/FeatureIcon'
import './ProcessingSettings.css'

interface Props {
  settings: ChunkSettings
  onOpenSettings: (section: 'conversion' | 'chunking') => void
}

export default function ProcessingSettings({ settings, onOpenSettings }: Props) {
  const { caps } = useCapabilities()
  const converter = caps?.converters.find(item => item.name === settings.converter)?.label ?? settings.converter
  const library = caps?.chunkers.find(item => item.library === settings.chunkerLibrary)
  const strategy = library?.strategies.find(item => item.strategy === settings.chunkerType)?.label
    ?? settings.chunkerType.replace(/_/g, ' ')
  const chunker = `${library?.label ?? settings.chunkerLibrary} / ${strategy}`
  const { usesSize, usesOverlap, unit } = chunkingOptions(settings)
  const parameters = [
    ...(usesSize ? [`${settings.chunkSize} ${unit}`] : []),
    ...(usesOverlap ? [`${settings.chunkOverlap} overlap`] : []),
  ].join(' · ')

  return (
    <div className="processing-settings" role="group" aria-label="Processing defaults">
      <button
        type="button"
        className="processing-setting"
        aria-label={`Converter settings: ${converter}`}
        title={`Next conversion: ${converter}. Click to change. Existing Markdown keeps its original converter.`}
        onClick={() => onOpenSettings('conversion')}
      >
        <FeatureIcon feature="convert" size={11} />
        <span className="processing-setting-value">{converter}</span>
      </button>
      <button
        type="button"
        className="processing-setting"
        aria-label={`Chunker settings: ${chunker}${parameters ? `, ${parameters}` : ''}`}
        title={`Generate chunks with ${chunker}${parameters ? ` (${parameters})` : ''}. Click to change. Saved versions retain their own settings.`}
        onClick={() => onOpenSettings('chunking')}
      >
        <FeatureIcon feature="chunk" size={11} />
        <span className="processing-setting-value">{chunker}</span>
      </button>
    </div>
  )
}
