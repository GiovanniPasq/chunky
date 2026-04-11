export interface Chunk {
  index: number
  content: string
  /** Cleaned/normalised text — populated post-enrichment */
  cleaned_chunk: string
  /** Auto-generated title — populated post-enrichment */
  title: string
  /** Surrounding document context — populated post-enrichment */
  context: string
  /** One-sentence summary — populated post-enrichment */
  summary: string
  /** Extracted keywords — populated post-enrichment */
  keywords: string[]
  /** Questions this chunk could answer — populated post-enrichment */
  questions: string[]
  metadata: Record<string, unknown>
  start: number
  end: number
}

export interface DocumentData {
  pdf_filename: string
  md_filename: string
  md_content: string
  has_markdown: boolean
  has_pdf: boolean
}

// ---------------------------------------------------------------------------
// Converter types — kept in sync with backend ConverterType enum.
// The canonical list now comes from GET /api/capabilities; this union type
// is kept as a fallback / TS convenience.
// ---------------------------------------------------------------------------
export type ConverterType = string   // open string so new converters need no FE change

export interface VLMSettings {
  model?: string
  base_url?: string
  api_key?: string
  temperature?: number
  user_prompt?: string
}

export interface CloudSettings {
  base_url?: string
  bearer_token?: string
}

export interface EnrichmentSettings {
  model?: string
  base_url?: string
  api_key?: string
  temperature?: number
  user_prompt?: string
}

// ---------------------------------------------------------------------------
// Splitter types — open strings; the authoritative list comes from
// GET /api/capabilities so new strategies appear automatically.
// ---------------------------------------------------------------------------
export type SplitterType = string
export type SplitterLibrary = string

export interface ChunkSettings {
  splitterType: SplitterType
  splitterLibrary: SplitterLibrary
  chunkSize: number
  chunkOverlap: number
  enableMarkdownSizing: boolean
  converter: ConverterType
  vlm?: VLMSettings
  cloud?: CloudSettings
  sectionEnrichment?: EnrichmentSettings
  chunkEnrichment?: EnrichmentSettings
}

// ---------------------------------------------------------------------------
// Capabilities — shape returned by GET /api/capabilities
// ---------------------------------------------------------------------------
export interface CapabilityStrategy {
  strategy: string
  label: string
  description: string
}

export interface CapabilityLibrary {
  library: string
  label: string
  strategies: CapabilityStrategy[]
}

export interface CapabilityConverter {
  name: string
  label: string
  description: string
}

export interface Capabilities {
  splitters: CapabilityLibrary[]
  converters: CapabilityConverter[]
}

// ---------------------------------------------------------------------------
// Enrichment progress — used by MarkdownViewer and enrichment hooks
// ---------------------------------------------------------------------------
export interface EnrichOp {
  title: string
  detail: string
  current: number
  total: number
  errorMessage?: string
}
