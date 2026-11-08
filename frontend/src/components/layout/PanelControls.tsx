import type { ChunksVersion, MarkdownVersion } from '../../types'
import { chunkingOptions } from '../../utils/chunkingOptions'

interface MarkdownVersionPickerProps {
  versions: MarkdownVersion[]
  selectedFilename: string | null
  onSelectIdentifier: (identifier: string) => void
}

export function MarkdownVersionPicker({
  versions,
  selectedFilename,
  onSelectIdentifier,
}: MarkdownVersionPickerProps) {
  if (versions.length === 0) return null

  return (
    <select
      className="panel-version-select"
      value={selectedFilename ?? ''}
      onChange={e => {
        const version = versions.find(x => x.filename === e.target.value)
        if (!version) return
        const identifier = version.source === 'converted' && version.converter
          ? version.converter
          : version.filename
        onSelectIdentifier(identifier)
      }}
      title="Switch between Markdown versions for this document"
      aria-label="Markdown version"
    >
      {versions.map(version => {
        const baseLabel = version.source === 'converted' && version.converter
          ? version.converter
          : `${version.filename} \u00b7 uploaded`
        const label = version.has_failures ? `${baseLabel} \u26a0` : baseLabel
        return <option key={version.filename} value={version.filename}>{label}</option>
      })}
    </select>
  )
}

interface ChunksVersionPickerProps {
  versions: ChunksVersion[]
  selectedFilename: string | null
  onLoadSavedChunks: (filename: string) => void
}

export function ChunksVersionPicker({
  versions,
  selectedFilename,
  onLoadSavedChunks,
}: ChunksVersionPickerProps) {
  if (versions.length === 0) return null

  return (
    <select
      className="panel-version-select"
      value={selectedFilename ?? ''}
      onChange={e => { if (e.target.value) onLoadSavedChunks(e.target.value) }}
      title="Load a previously saved chunk version"
      aria-label="Saved chunk version"
    >
      {!selectedFilename && <option value="" disabled hidden>{'\u2014 select a saved version \u2014'}</option>}
      {versions.map(version => {
        const { usesSize, usesOverlap } = chunkingOptions({
          chunkerLibrary: version.library,
          chunkerType: version.algorithm,
          enableMarkdownSizing: version.chunk_size != null,
        })
        const params: string[] = []
        if (usesSize && version.chunk_size != null) params.push(`size ${version.chunk_size}`)
        if (usesOverlap && version.chunk_overlap != null) params.push(`overlap ${version.chunk_overlap}`)
        const suffix = params.length > 0 ? ` (${params.join(', ')})` : ''
        return (
          <option key={version.filename} value={version.filename}>
            {`${version.library}/${version.algorithm}${suffix}${version.is_stale ? ' ⚠ stale' : ''}`}
          </option>
        )
      })}
    </select>
  )
}

interface ZoomControlProps {
  scale: number
  onScaleChange: (scale: number) => void
}

export function ZoomControl({ scale, onScaleChange }: ZoomControlProps) {
  return (
    <div className="panel-zoom" title="Zoom">
      <button aria-label="Zoom out" onClick={() => onScaleChange(Math.max(0.5, scale - 0.1))} disabled={scale <= 0.5}>{'\u2212'}</button>
      <span>{(scale * 100).toFixed(0)}%</span>
      <button aria-label="Zoom in" onClick={() => onScaleChange(Math.min(3, scale + 0.1))} disabled={scale >= 3}>+</button>
    </div>
  )
}
