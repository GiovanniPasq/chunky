import type { ChunkSettings } from '../types'

/** Parameter meanings shared by controls, cache keys, and saved-version matching. */
export function chunkingOptions(settings: Pick<ChunkSettings, 'chunkerLibrary' | 'chunkerType' | 'enableMarkdownSizing'>) {
  const { chunkerLibrary: library, chunkerType: strategy } = settings
  if (library === 'docling') return { usesSize: true, usesOverlap: false, unit: 'tokens' }
  if (library === 'chonkie') {
    const usesSize = strategy !== 'table' && strategy !== 'neural'
    return {
      usesSize,
      usesOverlap: usesSize && (strategy === 'token' || strategy === 'sentence'),
      unit: strategy === 'table' ? 'rows' : strategy === 'fast' ? 'bytes'
        : strategy === 'token' || strategy === 'semantic' ? 'tokens' : 'chars',
    }
  }
  const enabled = strategy !== 'markdown' || settings.enableMarkdownSizing
  return { usesSize: enabled, usesOverlap: enabled, unit: strategy === 'token' ? 'tokens' : 'chars' }
}
