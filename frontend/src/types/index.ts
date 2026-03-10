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

// DocumentInfo and DocumentData are identical shapes — one alias is enough
export type DocumentInfo = DocumentData

export type ConverterType = 'pymupdf' | 'docling' | 'markitdown' | 'vlm'

export interface VLMSettings {
  model?: string
  base_url?: string
  api_key?: string
}

export interface ChunkSettings {
  splitterType: 'token' | 'recursive' | 'character' | 'markdown'
  chunkSize: number
  chunkOverlap: number
  enableMarkdownSizing: boolean
  converter: ConverterType
  vlm?: VLMSettings
}