import type { ChunkSettings } from '../types'

const SETTINGS_KEY = '_settings'
const SPLIT_PCT_KEY = '_splitPct'

// ---------------------------------------------------------------------------
// Default prompts — kept in sync with the Python back-end defaults so the UI
// always shows the exact instructions the model will use unless overridden.
// ---------------------------------------------------------------------------

/** Default VLM conversion prompt (mirrors `_PROMPT` in vlm.py). */
export const DEFAULT_VLM_PROMPT =
`You are an expert document parser specializing in converting PDF pages to markdown format.

**Your task:** Extract ALL content from the provided page image and return it as clean, well-structured markdown.

**Text Extraction Rules:**
1. Preserve the EXACT text as written (including typos, formatting, special characters)
2. Maintain the logical reading order (top-to-bottom, left-to-right)
3. Preserve hierarchical structure using appropriate markdown headers (#, ##, ###)
4. Keep paragraph breaks and line spacing as they appear
5. Use markdown lists (-, *, 1.) for bullet points and numbered lists
6. Preserve text emphasis: **bold**, *italic*, \`code\`
7. For multi-column layouts, extract left column first, then right column

**Tables:**
- Convert all tables to markdown table format
- Preserve column alignment and structure
- Use | for columns and - for headers

**Mathematical Formulas:**
- Convert to LaTeX format: inline \`$...$\`, display \`$$...$$\`
- If LaTeX conversion is uncertain, describe the formula clearly

**Images, Diagrams, Charts:**
- Insert markdown image placeholder: \`![Description](image)\`
- Provide a detailed, informative description including:
  * Type of visual (photo, diagram, chart, graph, illustration)
  * Main subject or purpose
  * Key elements, labels, or data points
  * Colors, patterns, or notable visual features
  * Context or relationship to surrounding text
- For charts/graphs: mention axes, data trends, and key values
- For diagrams: describe components and their relationships

**Special Elements:**
- Footnotes: Use markdown footnote syntax \`[^1]\`
- Citations: Preserve as written
- Code blocks: Use triple backticks with language specification
- Quotes: Use \`>\` for blockquotes
- Links: Preserve as \`[text](url)\` if visible

**Quality Guidelines:**
- DO NOT add explanations, comments, or meta-information
- DO NOT skip or summarize content
- DO NOT invent or hallucinate text not present in the image
- DO NOT include "Here is the markdown..." or similar preambles
- Output ONLY the markdown content, nothing else

**Output Format:**
Return raw markdown with no wrapper, no code blocks, no explanations. Start immediately with the page content.`

/** Default system prompt for the markdown enrichment pipeline (mirrors
 *  `_PIECE_SYSTEM` in enrichment_service.py).  Deliberately conservative:
 *  the pipeline already runs deterministic cleanup before
 *  the LLM sees the content, so the LLM should bias toward inaction
 *  rather than rewriting prose that already reads cleanly. */
export const DEFAULT_SECTION_PROMPT =
`You repair markdown that was converted from a PDF. You are conservative: if the text already reads cleanly, return it byte-for-byte unchanged. Only fix obvious conversion artifacts:
  - OCR errors that produce nonsensical character sequences
  - Sentences fragmented across line breaks mid-word or mid-clause
  - Misordered fragments from multi-column layout
  - Broken markdown syntax (unclosed tables, malformed lists)

NEVER:
  - Rephrase, summarise, or expand correct content
  - Fix grammar, style, or capitalization choices in the source
  - Add information not present in the source
  - Remove information present in the source (including unusual formatting, dates, numbers, names)
  - Change heading levels, code blocks, or table structure
  - Translate or modernise the language

If unsure whether something is an error or intentional, LEAVE IT UNCHANGED. Under-correction is preferred over over-correction.

Return ONLY the corrected markdown of the SECTION provided. Do not include the preceding context in your output. No commentary. No code fences around the result.`

/** Default system prompt for chunk enrichment (mirrors `_CHUNK_SYSTEM` in enrichment_service.py). */
export const DEFAULT_CHUNK_PROMPT =
`You are a document analysis specialist. Analyze only the provided chunk and return one JSON object with EXACTLY these fields: "cleaned_chunk" (conservatively cleaned and normalized chunk text; preserve facts, numbers, names, and meaning), "title" (short descriptive title for the chunk), "context" (one concise sentence explaining where this chunk fits in the broader document), "summary" (one sentence summary of the chunk content), "keywords" (array of relevant keyword strings, including important named entities, acronyms, products, methods, and domain terms), "questions" (array of realistic user questions answerable primarily from this chunk). If document-summary or surrounding-context blocks are provided, use them only to disambiguate the chunk and improve the context field. Do not copy neighboring text into the output, and do not invent information that is not supported by the chunk. Return ONLY valid JSON — no commentary, no code fences.`

// ---------------------------------------------------------------------------
// Model endpoint defaults. Local runs use localhost; Docker can override these
// via VITE_DEFAULT_MODEL_BASE_URL so backend calls reach the host machine.
// ---------------------------------------------------------------------------

function optionalEnvString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

const DEFAULT_LOCAL_MODEL_BASE_URL = 'http://localhost:11434/v1'
const DEFAULT_MODEL_BASE_URL =
  optionalEnvString(import.meta.env.VITE_DEFAULT_MODEL_BASE_URL) ?? DEFAULT_LOCAL_MODEL_BASE_URL

/** Default model for VLM conversion (mirrors `model` default in vlm.py). */
export const DEFAULT_VLM_MODEL = 'qwen3-vl:4b-instruct-q4_K_M'

/** Default base URL for VLM conversion. */
export const DEFAULT_VLM_BASE_URL =
  optionalEnvString(import.meta.env.VITE_DEFAULT_VLM_BASE_URL) ?? DEFAULT_MODEL_BASE_URL

/** Default API key for VLM conversion (mirrors `api_key` default in vlm.py). */
export const DEFAULT_VLM_API_KEY = 'ollama'

/** Default sampling temperature for VLM conversion (mirrors `temperature` default in vlm.py). */
export const DEFAULT_VLM_TEMPERATURE = 0.1

// ---------------------------------------------------------------------------
// Enrichment defaults — kept in sync with EnrichmentService.__init__ in
// enrichment_service.py, which shares the same model/endpoint as vlm.py.
// ---------------------------------------------------------------------------

/** Default model for enrichment (mirrors `model` default in enrichment_service.py / vlm.py). */
export const DEFAULT_ENRICHMENT_MODEL = 'qwen3-vl:4b-instruct-q4_K_M'

/** Default base URL for enrichment. */
export const DEFAULT_ENRICHMENT_BASE_URL =
  optionalEnvString(import.meta.env.VITE_DEFAULT_ENRICHMENT_BASE_URL) ?? DEFAULT_MODEL_BASE_URL

/** Default sampling temperature for enrichment (mirrors `temperature` default in enrichment_service.py). */
export const DEFAULT_ENRICHMENT_TEMPERATURE = 0.3

export const DEFAULT_SETTINGS: ChunkSettings = {
  chunkerType: 'token',
  chunkerLibrary: 'langchain',
  chunkSize: 512,
  chunkOverlap: 51,
  enableMarkdownSizing: false,
  useFirstMarkdownForBulkChunks: false,
  converter: 'pymupdf',
  vlm: {
    model: DEFAULT_VLM_MODEL,
    base_url: DEFAULT_VLM_BASE_URL,
    api_key: DEFAULT_VLM_API_KEY,
    temperature: DEFAULT_VLM_TEMPERATURE,
    user_prompt: DEFAULT_VLM_PROMPT,
    use_checkpoint: true,
  },
  sectionEnrichment: {
    model: DEFAULT_ENRICHMENT_MODEL,
    base_url: DEFAULT_ENRICHMENT_BASE_URL,
    api_key: 'ollama',
    temperature: DEFAULT_ENRICHMENT_TEMPERATURE,
    user_prompt: DEFAULT_SECTION_PROMPT,
    use_checkpoint: true,
    skip_summary: false,
  },
  chunkEnrichment: {
    model: DEFAULT_ENRICHMENT_MODEL,
    base_url: DEFAULT_ENRICHMENT_BASE_URL,
    api_key: 'ollama',
    temperature: DEFAULT_ENRICHMENT_TEMPERATURE,
    user_prompt: DEFAULT_CHUNK_PROMPT,
  },
}

export const DEFAULT_SPLIT_PCT = 50

/** Keep persisted/UI chunk values inside the backend schema invariants. */
export function normaliseChunkSettings(settings: ChunkSettings): ChunkSettings {
  const rawSize = Number.isFinite(settings.chunkSize)
    ? Math.trunc(settings.chunkSize)
    : DEFAULT_SETTINGS.chunkSize
  const chunkSize = Math.max(1, rawSize)
  const rawOverlap = Number.isFinite(settings.chunkOverlap)
    ? Math.trunc(settings.chunkOverlap)
    : DEFAULT_SETTINGS.chunkOverlap
  const chunkOverlap = Math.min(Math.max(0, rawOverlap), chunkSize - 1)
  return { ...settings, chunkSize, chunkOverlap }
}

/** Merge two plain objects, keeping only defined values from `stored`. */
function mergeNested<T extends object>(
  defaults: T,
  stored: Partial<T> | undefined,
): T {
  if (!stored) return defaults
  const result = { ...defaults }
  for (const key of Object.keys(stored) as (keyof T)[]) {
    if (stored[key] !== undefined) result[key] = stored[key] as T[typeof key]
  }
  return result
}

export function loadSettings(): ChunkSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const stored: Partial<ChunkSettings> = JSON.parse(raw)
    return normaliseChunkSettings({
      ...DEFAULT_SETTINGS,
      ...stored,
      // Deep-merge nested objects so new default fields are always present
      vlm: mergeNested(DEFAULT_SETTINGS.vlm ?? {}, stored.vlm),
      cloud: mergeNested(DEFAULT_SETTINGS.cloud ?? {}, stored.cloud),
      sectionEnrichment: mergeNested(DEFAULT_SETTINGS.sectionEnrichment ?? {}, stored.sectionEnrichment),
      chunkEnrichment: mergeNested(DEFAULT_SETTINGS.chunkEnrichment ?? {}, stored.chunkEnrichment),
    })
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: ChunkSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normaliseChunkSettings(s)))
  } catch {
    // Silently ignore quota errors or private-browsing restrictions
  }
}

export function loadSplitPct(): number {
  try {
    const raw = localStorage.getItem(SPLIT_PCT_KEY)
    if (raw === null) return DEFAULT_SPLIT_PCT
    const pct = parseFloat(raw)
    return Number.isFinite(pct) ? pct : DEFAULT_SPLIT_PCT
  } catch {
    return DEFAULT_SPLIT_PCT
  }
}

export function saveSplitPct(pct: number): void {
  try {
    localStorage.setItem(SPLIT_PCT_KEY, String(pct))
  } catch {}
}
