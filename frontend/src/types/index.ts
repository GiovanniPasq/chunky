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
  /**
   * When true (default), an interrupted VLM conversion resumes from the
   * per-page checkpoint saved by the previous run.  When false, any
   * existing checkpoint is discarded and the document is reconverted
   * from page 1.
   */
  use_checkpoint?: boolean
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
  /**
   * Pipeline enrichment: when true (default), per-piece corrections from a
   * previous run are reused on re-run if every output-determining input
   * (piece content, context, prompt, model, endpoint, temperature, and
   * document summary) is unchanged. When
   * false, the cache is discarded and every piece is reconverted from
   * scratch.  Only the markdown enrichment pipeline reads this flag;
   * chunk enrichment ignores it.
   */
  use_checkpoint?: boolean
  /**
   * Pipeline enrichment: when true, the SummaryReviewModal is bypassed
   * entirely on Enrich click and the pipeline runs WITHOUT a document
   * summary (cleanup + per-piece corrections only, no document-level
   * context block in the piece prompts).  Use to skip the ~30s
   * summary build on long PDFs when you only want OCR / sentence-join
   * fixes.  Defaults to false (show the review modal).
   */
  skip_summary?: boolean
}


// ---------------------------------------------------------------------------
// Document-level summary
//
// One record per source document, reused across converter variants of a PDF.
// The Summary Review modal lets the user inspect, edit, or regenerate it
// before an enrichment pipeline runs.
// ---------------------------------------------------------------------------

export interface DocumentSummary {
  topic: string
  narrative: string
}

export interface DocumentSummaryStatus {
  /**
   * True when the most recent persistence happened via the PUT endpoint
   * (i.e. the user edited the summary in the review modal).  Protects
   * the content against silent overwrites by future pipeline runs —
   * only an explicit Regenerate or PDF re-upload replaces it.
   */
  user_edited: boolean
  generated_at: string
}

export interface DocumentSummaryResponse {
  filename: string
  doc_stem: string
  summary: DocumentSummary
  status: DocumentSummaryStatus
}

// ---------------------------------------------------------------------------
// Chunker types — open strings; the authoritative list comes from
// GET /api/capabilities so new strategies appear automatically.
// ---------------------------------------------------------------------------
export type ChunkerType = string
export type ChunkerLibrary = string

export interface ChunkSettings {
  chunkerType: ChunkerType
  chunkerLibrary: ChunkerLibrary
  chunkSize: number
  chunkOverlap: number
  enableMarkdownSizing: boolean
  useFirstMarkdownForBulkChunks: boolean
  converter: ConverterType
  vlm?: VLMSettings
  cloud?: CloudSettings
  sectionEnrichment?: EnrichmentSettings
  chunkEnrichment?: EnrichmentSettings
}

// ---------------------------------------------------------------------------
// Versioned markdowns / chunks — shape returned by:
//   GET /api/documents/{name}/markdowns
//   GET /api/documents/{name}/chunks
// ---------------------------------------------------------------------------
export interface MarkdownVersion {
  filename: string
  source: 'converted' | 'uploaded'
  converter: string | null
  /** True iff this variant contains VLM ``<!-- page N failed: … -->``
   *  placeholders left by a partial conversion.  Drives the ⚠ marker
   *  next to the variant's entry in the version picker. */
  has_failures?: boolean
}

export interface ChunksVersion {
  filename: string
  md_filename: string | null
  md_source: string | null
  library: string
  algorithm: string
  chunk_size: number | null
  chunk_overlap: number | null
  source_hash: string | null
  is_stale: boolean
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
  chunkers: CapabilityLibrary[]
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
