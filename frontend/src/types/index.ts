export interface Chunk {
  index: number
  content: string
  metadata: Record<string, unknown>
  start: number
  end: number
}

export interface DocumentData {
  pdf_filename: string
  md_filename: string
  md_content: string
  has_markdown: boolean
}

export interface DocumentInfo {
  pdf_filename: string
  md_filename: string
  md_content: string
  has_markdown: boolean
}

export interface ChunkSettings {
  splitterType: 'token' | 'recursive' | 'character' | 'markdown'
  chunkSize: number
  chunkOverlap: number
  enableMarkdownSizing: boolean
}
