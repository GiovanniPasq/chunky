import { describe, expect, it } from 'vitest'
import { chunkingOptions } from './chunkingOptions'
import { buildChunkConfigSignature, isChunksVersionForSettings } from './chunkUtils'
import type { ChunkSettings, ChunksVersion } from '../types'

const base: ChunkSettings = {
  chunkerLibrary: 'langchain', chunkerType: 'token', chunkSize: 512, chunkOverlap: 51,
  enableMarkdownSizing: false, useFirstMarkdownForBulkChunks: false, converter: 'pymupdf',
}

describe('strategy parameter semantics', () => {
  it.each([
    ['langchain', 'token', 'tokens', true, true],
    ['langchain', 'recursive', 'chars', true, true],
    ['langchain', 'character', 'chars', true, true],
    ['langchain', 'markdown', 'chars', false, false],
    ['chonkie', 'token', 'tokens', true, true],
    ['chonkie', 'sentence', 'chars', true, true],
    ['chonkie', 'recursive', 'chars', true, false],
    ['chonkie', 'fast', 'bytes', true, false],
    ['chonkie', 'table', 'rows', false, false],
    ['chonkie', 'code', 'chars', true, false],
    ['chonkie', 'semantic', 'tokens', true, false],
    ['chonkie', 'neural', 'chars', false, false],
    ['docling', 'hybrid', 'tokens', true, false],
    ['docling', 'line_based', 'tokens', true, false],
  ])('%s/%s exposes the effective controls', (library, strategy, unit, usesSize, usesOverlap) => {
    expect(chunkingOptions({ ...base, chunkerLibrary: String(library), chunkerType: String(strategy) }))
      .toEqual({ unit, usesSize, usesOverlap })
  })

  it('enables sizing and overlap for capped Markdown sections', () => {
    expect(chunkingOptions({ ...base, chunkerType: 'markdown', enableMarkdownSizing: true }))
      .toMatchObject({ usesSize: true, usesOverlap: true })
  })

  it('does not rechunk Semantic when only its ignored overlap changes', () => {
    const settings = { ...base, chunkerLibrary: 'chonkie', chunkerType: 'semantic' }
    const signature = (s: ChunkSettings) => buildChunkConfigSignature('x.md', 'x.md', 'uploaded', s, 0, 'revision')
    expect(signature(settings)).toBe(signature({ ...settings, chunkOverlap: 0 }))
    expect(signature(settings)).not.toBe(signature({ ...settings, chunkSize: 256 }))
  })

  it('matches legacy Semantic versions regardless of ignored overlap', () => {
    const version: ChunksVersion = {
      filename: 'x_uploaded_chonkie-semantic_512_99.json', md_filename: 'x.md', md_source: 'uploaded',
      library: 'chonkie', algorithm: 'semantic', chunk_size: 512, chunk_overlap: 99,
      source_hash: 'current', is_stale: false,
    }
    expect(isChunksVersionForSettings(version, { ...base, chunkerLibrary: 'chonkie', chunkerType: 'semantic' })).toBe(true)
    expect(isChunksVersionForSettings(version, { ...base, chunkerLibrary: 'chonkie', chunkerType: 'semantic', chunkSize: 100 })).toBe(false)
  })

  it('does not rechunk size-independent strategies for unused setting changes', () => {
    const settings = { ...base, chunkerLibrary: 'chonkie', chunkerType: 'table' }
    const signature = (s: ChunkSettings) => buildChunkConfigSignature('x.md', 'x.md', 'uploaded', s, 0, 'revision')
    expect(signature(settings)).toBe(signature({ ...settings, chunkSize: 4096, chunkOverlap: 999, enableMarkdownSizing: true }))
  })
})
