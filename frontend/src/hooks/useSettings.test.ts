import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normaliseChunkSettings } from './useSettings'

describe('normaliseChunkSettings', () => {
  it('keeps overlap below size before requests are sent', () => {
    const result = normaliseChunkSettings({
      ...DEFAULT_SETTINGS,
      chunkSize: 100,
      chunkOverlap: 500,
    })

    expect(result.chunkSize).toBe(100)
    expect(result.chunkOverlap).toBe(99)
  })

  it('repairs invalid persisted numeric values', () => {
    const result = normaliseChunkSettings({
      ...DEFAULT_SETTINGS,
      chunkSize: Number.NaN,
      chunkOverlap: -20,
    })

    expect(result.chunkSize).toBe(DEFAULT_SETTINGS.chunkSize)
    expect(result.chunkOverlap).toBe(0)
  })
})
