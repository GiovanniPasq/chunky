import type { DocumentInfo, Chunk, ChunkSettings } from '../types'

const BASE = '/api'

export const documentService = {
  async list(): Promise<string[]> {
    const res = await fetch(`${BASE}/documents`)
    if (!res.ok) throw new Error('Failed to fetch documents')
    return res.json()
  },

  async get(filename: string): Promise<DocumentInfo> {
    const res = await fetch(`${BASE}/document/${filename}`)
    if (!res.ok) throw new Error('Failed to fetch document')
    return res.json()
  },

  async upload(file: File): Promise<{ filename: string }> {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form })
    if (!res.ok) throw new Error('Upload failed')
    return res.json()
  },

  async convert(filename: string): Promise<DocumentInfo> {
    const res = await fetch(`${BASE}/convert/${filename}`, { method: 'POST' })
    if (!res.ok) throw new Error('Conversion failed')
    // reload after convert
    return documentService.get(filename)
  },

  async saveMarkdown(filename: string, content: string): Promise<void> {
    const blob = new Blob([content], { type: 'text/markdown' })
    const mdFilename = filename.replace('.pdf', '.md')
    const file = new File([blob], mdFilename, { type: 'text/markdown' })
    await documentService.upload(file)
  },
}

export const chunkService = {
  async chunk(content: string, settings: ChunkSettings): Promise<Chunk[]> {
    const res = await fetch(`${BASE}/chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        splitter_type: settings.splitterType,
        chunk_size: settings.chunkSize,
        chunk_overlap: settings.chunkOverlap,
        enable_markdown_sizing: settings.enableMarkdownSizing,
      }),
    })
    if (!res.ok) throw new Error('Chunking failed')
    const data = await res.json()
    return data.chunks
  },

  async save(filename: string, chunks: Chunk[]): Promise<void> {
    const res = await fetch(`${BASE}/chunks/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, chunks }),
    })
    if (!res.ok) throw new Error('Save failed')
  },

  async load(filename: string): Promise<Chunk[] | null> {
    const res = await fetch(`${BASE}/chunks/load/${filename}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error('Load failed')
    const data = await res.json()
    return data.chunks
  },
}
