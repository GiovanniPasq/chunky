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

/** Default system prompt for markdown enrichment (mirrors `_MARKDOWN_SYSTEM` in enrichment_service.py). */
export const DEFAULT_SECTION_PROMPT =
`You are a markdown document quality specialist. Your task is to improve markdown documents that were converted from PDFs. Correct conversion artifacts, fix broken formatting, remove duplicate or garbled content, and improve readability while strictly preserving all original information. Return ONLY the corrected markdown — no commentary, no code fences.`

/** Default system prompt for chunk enrichment (mirrors `_CHUNK_SYSTEM` in enrichment_service.py). */
export const DEFAULT_CHUNK_PROMPT =
`You are a document analysis specialist. Analyze the provided text chunk and return a JSON object with EXACTLY these fields: "cleaned_chunk" (cleaned normalized text), "title" (short descriptive title), "context" (one sentence describing the surrounding document context), "summary" (one sentence summary), "keywords" (array of keyword strings), "questions" (array of questions this chunk could answer). Return ONLY valid JSON — no commentary, no code fences.`

// ---------------------------------------------------------------------------
// Enrichment defaults — kept in sync with EnrichmentService.__init__ in
// enrichment_service.py, which shares the same model/endpoint as vlm.py.
// ---------------------------------------------------------------------------

/** Default model for enrichment (mirrors `model` default in enrichment_service.py / vlm.py). */
export const DEFAULT_ENRICHMENT_MODEL = 'qwen3-vl:4b-instruct-q4_K_M'

/** Default base URL for enrichment (mirrors `base_url` default in enrichment_service.py / vlm.py). */
export const DEFAULT_ENRICHMENT_BASE_URL = 'http://localhost:11434/v1'

/** Default sampling temperature for enrichment (mirrors `temperature` default in enrichment_service.py). */
export const DEFAULT_ENRICHMENT_TEMPERATURE = 0.3

export const DEFAULT_SETTINGS: ChunkSettings = {
  splitterType: 'token',
  splitterLibrary: 'langchain',
  chunkSize: 512,
  chunkOverlap: 51,
  enableMarkdownSizing: false,
  converter: 'pymupdf',
  sectionEnrichment: {
    model: DEFAULT_ENRICHMENT_MODEL,
    base_url: DEFAULT_ENRICHMENT_BASE_URL,
    temperature: DEFAULT_ENRICHMENT_TEMPERATURE,
  },
  chunkEnrichment: {
    model: DEFAULT_ENRICHMENT_MODEL,
    base_url: DEFAULT_ENRICHMENT_BASE_URL,
    temperature: DEFAULT_ENRICHMENT_TEMPERATURE,
  },
}

export const DEFAULT_SPLIT_PCT = 50

/** Merge two plain objects, keeping only defined values from `stored`. */
function mergeNested<T extends Record<string, unknown>>(
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
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      // Deep-merge nested objects so new default fields are always present
      vlm: mergeNested(DEFAULT_SETTINGS.vlm ?? {}, stored.vlm),
      sectionEnrichment: mergeNested(DEFAULT_SETTINGS.sectionEnrichment ?? {}, stored.sectionEnrichment),
      chunkEnrichment: mergeNested(DEFAULT_SETTINGS.chunkEnrichment ?? {}, stored.chunkEnrichment),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: ChunkSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
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

export function clearPersistedSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY)
    localStorage.removeItem(SPLIT_PCT_KEY)
  } catch {}
}
