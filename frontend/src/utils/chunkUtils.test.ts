import { describe, expect, it } from 'vitest'
import type { ChunkSettings, ChunksVersion } from '../types'
import {
  buildChunkConfigSignature,
  buildContentRevision,
  findMatchingSavedChunks,
  isCurrentChunkRevision,
  normaliseChunk,
  reconcileChunkEnrichmentAfterEdit,
} from './chunkUtils'

const settings: ChunkSettings = {
  chunkerType: 'token',
  chunkerLibrary: 'langchain',
  chunkSize: 512,
  chunkOverlap: 51,
  enableMarkdownSizing: true,
  useFirstMarkdownForBulkChunks: false,
  converter: 'vlm',
}

describe('chunkUtils', () => {
  it('includes compact markdown revisions in chunk config signatures', () => {
    const oldRevision = buildContentRevision('old markdown')
    const newRevision = buildContentRevision('new markdown')

    expect(newRevision).not.toEqual(oldRevision)

    const before = buildChunkConfigSignature(
      'report.pdf',
      'report_vlm.md',
      'vlm',
      settings,
      1,
      oldRevision,
    )
    const after = buildChunkConfigSignature(
      'report.pdf',
      'report_vlm.md',
      'vlm',
      settings,
      1,
      newRevision,
    )

    expect(after).not.toEqual(before)
    expect(after).not.toContain('new markdown')
  })

  it('finds saved chunks for the active markdown source and settings', () => {
    const versions: ChunksVersion[] = [
      {
        filename: 'report_docling_langchain-token_512_51.json',
        md_filename: 'report_docling.md',
        md_source: 'docling',
        library: 'langchain',
        algorithm: 'token',
        chunk_size: 512,
        chunk_overlap: 51,
        source_hash: 'abc',
        is_stale: false,
      },
      {
        filename: 'report_vlm_langchain-token_512_51.json',
        md_filename: 'report_vlm.md',
        md_source: 'vlm',
        library: 'langchain',
        algorithm: 'token',
        chunk_size: 512,
        chunk_overlap: 51,
        source_hash: 'def',
        is_stale: false,
      },
    ]

    expect(findMatchingSavedChunks(versions, 'vlm', settings)?.filename)
      .toBe('report_vlm_langchain-token_512_51.json')
  })

  it('does not auto-match stale saved chunks', () => {
    const version: ChunksVersion = {
      filename: 'report_vlm_langchain-token_512_51.json',
      md_filename: 'report_vlm.md',
      md_source: 'vlm',
      library: 'langchain',
      algorithm: 'token',
      chunk_size: 512,
      chunk_overlap: 51,
      source_hash: 'old',
      is_stale: true,
    }

    expect(findMatchingSavedChunks([version], 'vlm', settings)).toBeUndefined()
  })

  it('normalises sparse chunk payloads into the full UI shape', () => {
    const raw = {
      index: 2,
      content: 'hello',
      keywords: 'alpha',
    } as unknown as Parameters<typeof normaliseChunk>[0]

    expect(normaliseChunk(raw)).toEqual({
      index: 2,
      content: 'hello',
      cleaned_chunk: '',
      title: '',
      context: '',
      summary: '',
      keywords: ['alpha'],
      questions: [],
      metadata: {},
      start: 0,
      end: 0,
    })
  })

  it('clears stale enrichment when only chunk content changes', () => {
    const original = normaliseChunk({
      index: 0,
      content: 'Original text',
      cleaned_chunk: 'Original text',
      title: 'Original title',
      context: 'Original context',
      summary: 'Original summary',
      keywords: ['original'],
      questions: ['What is original?'],
    })

    expect(reconcileChunkEnrichmentAfterEdit(original, 'Rewritten text', {
      cleaned_chunk: original.cleaned_chunk,
      title: original.title,
      context: original.context,
      summary: original.summary,
      keywords: original.keywords,
      questions: original.questions,
    })).toMatchObject({
      cleaned_chunk: '',
      title: '',
      context: '',
      summary: '',
      keywords: [],
      questions: [],
    })
  })

  it('preserves enrichment explicitly edited with new chunk content', () => {
    const original = normaliseChunk({
      index: 0,
      content: 'Original text',
      title: 'Original title',
      summary: 'Original summary',
    })

    const updates = reconcileChunkEnrichmentAfterEdit(original, 'Rewritten text', {
      title: 'Updated title',
      summary: original.summary,
    })

    expect(updates.title).toBe('Updated title')
    expect(updates.summary).toBe('')
  })

  it('rejects async results from a replaced chunk set', () => {
    expect(isCurrentChunkRevision(4, 4)).toBe(true)
    expect(isCurrentChunkRevision(4, 5)).toBe(false)
  })

  it('matches size-independent Chonkie versions across size settings', () => {
    const version: ChunksVersion = {
      filename: 'report_vlm_chonkie-table.json',
      md_filename: 'report_vlm.md',
      md_source: 'vlm',
      library: 'chonkie',
      algorithm: 'table',
      chunk_size: null,
      chunk_overlap: null,
      source_hash: 'current',
      is_stale: false,
    }
    const tableSettings = { ...settings, chunkerLibrary: 'chonkie', chunkerType: 'table' }

    expect(findMatchingSavedChunks([version], 'vlm', tableSettings)).toBe(version)
    expect(findMatchingSavedChunks(
      [version],
      'vlm',
      { ...tableSettings, chunkSize: 4096, chunkOverlap: 999 },
    )).toBe(version)
  })
})
