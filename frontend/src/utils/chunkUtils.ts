import type { Chunk, ChunkSettings, ChunksVersion } from '../types'

/**
 * Stable signature describing the (document, MD source, splitter config) tuple
 * that produced a set of chunks.  Used by ``useChunks`` to skip redundant
 * re-chunking when the user merely toggles the panel back into view, and to
 * mark a freshly-loaded saved version as "already satisfied".  Both call
 * sites must agree on the field order or the comparison breaks silently —
 * keep them routed through this helper.
 */
export function buildChunkConfigSignature(
  selectedDoc: string | null,
  mdFilename: string | null,
  currentMdSource: string | null,
  settings: ChunkSettings,
  availableChunksCount: number,
  mdContentRevision: string,
): string {
  return JSON.stringify([
    selectedDoc,
    mdFilename,
    currentMdSource,
    settings.chunkerType,
    settings.chunkerLibrary,
    settings.chunkSize,
    settings.chunkOverlap,
    settings.enableMarkdownSizing,
    availableChunksCount,
    mdContentRevision,
  ])
}

/** Compact deterministic revision for content-sensitive cache signatures. */
export function buildContentRevision(content: string): string {
  let hash = 2166136261
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `${content.length}:${(hash >>> 0).toString(36)}`
}

/** Late async results may update chunks only while their owning revision is active. */
export function isCurrentChunkRevision(startedAt: number, current: number): boolean {
  return startedAt === current
}

/** Returns true if any enrichment field has been populated for the given chunk. */
export function isChunkEnriched(chunk: Chunk): boolean {
  return !!(
    chunk.title ||
    chunk.summary ||
    chunk.context ||
    chunk.cleaned_chunk ||
    chunk.keywords?.length ||
    chunk.questions?.length
  )
}

function sameStringList(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Keep enrichment only when it was explicitly edited with new chunk text.
 *
 * Otherwise the metadata describes the previous content and must be cleared.
 */
export function reconcileChunkEnrichmentAfterEdit(
  original: Chunk,
  updatedContent: string,
  updates: Partial<Chunk>,
): Partial<Chunk> {
  if (updatedContent === original.content) return updates

  return {
    ...updates,
    cleaned_chunk: (updates.cleaned_chunk ?? original.cleaned_chunk) === original.cleaned_chunk
      ? ''
      : updates.cleaned_chunk,
    title: (updates.title ?? original.title) === original.title ? '' : updates.title,
    context: (updates.context ?? original.context) === original.context ? '' : updates.context,
    summary: (updates.summary ?? original.summary) === original.summary ? '' : updates.summary,
    keywords: sameStringList(updates.keywords ?? original.keywords, original.keywords)
      ? []
      : updates.keywords,
    questions: sameStringList(updates.questions ?? original.questions, original.questions)
      ? []
      : updates.questions,
  }
}

/**
 * Returns a user-facing error message when a required `model` field is missing
 * from enrichment settings.  Keeps the wording consistent across hooks.
 */
export function missingEnrichmentModelError(label: string): string {
  return `Configure ${label} (model) in Settings → Enrichment tab.`
}

/**
 * Coerce a raw chunk payload (from the SSE stream or a saved JSON file) into
 * the strict {@link Chunk} shape the UI expects, filling in missing
 * enrichment fields with sensible defaults.
 *
 * Used by every code path that ingests chunks coming back from the backend
 * so the normalisation logic isn't repeated in three places.
 */
function asString(value: unknown): string {
  return value == null ? '' : String(value)
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function asStringList(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') {
    const item = value.trim()
    return item ? [item] : []
  }
  if (!Array.isArray(value)) return []
  return value
    .map(item => asString(item).trim())
    .filter(Boolean)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function normaliseChunk(raw: Partial<Chunk> & { index: number; content: string }): Chunk {
  return {
    index: asNumber(raw.index),
    content: asString(raw.content),
    cleaned_chunk: asString(raw.cleaned_chunk),
    title: asString(raw.title),
    context: asString(raw.context),
    summary: asString(raw.summary),
    keywords: asStringList(raw.keywords),
    questions: asStringList(raw.questions),
    metadata: asRecord(raw.metadata),
    start: asNumber(raw.start),
    end: asNumber(raw.end),
  }
}

/**
 * Find the saved-chunks file (if any) that was generated from the current
 * Markdown variant with the same chunker configuration as *settings*.
 *
 * Saved files only encode size/overlap when the algorithm actually uses
 * them — those fields are ``null`` on disk for size-less or overlap-less
 * algorithms.  The match treats those nulls as "wildcard": the parameter
 * is irrelevant for that algorithm, so any current frontend value
 * matches.
 */
export function findMatchingSavedChunks(
  versions: ChunksVersion[],
  mdSource: string | null,
  settings: ChunkSettings,
): ChunksVersion | undefined {
  return versions.find(v => v.md_source === mdSource && isChunksVersionForSettings(v, settings))
}

/** True when a saved chunks version was produced by the active chunker config. */
export function isChunksVersionForSettings(v: ChunksVersion, settings: ChunkSettings): boolean {
  if (v.is_stale) return false
  if (
    v.library === 'langchain' &&
    v.algorithm === 'markdown' &&
    settings.chunkerLibrary === 'langchain' &&
    settings.chunkerType === 'markdown'
  ) {
    if (settings.enableMarkdownSizing) {
      return v.chunk_size === settings.chunkSize && v.chunk_overlap === settings.chunkOverlap
    }
    return v.chunk_size === null && v.chunk_overlap === null
  }

  return (
    v.library === settings.chunkerLibrary &&
    v.algorithm === settings.chunkerType &&
    (v.chunk_size === null || v.chunk_size === settings.chunkSize) &&
    (v.chunk_overlap === null || v.chunk_overlap === settings.chunkOverlap)
  )
}

/**
 * Project a {@link Chunk} into the wire shape expected by ``POST /chunks/save``.
 * Pure (no side effects, no defaults beyond what {@link normaliseChunk}
 * already provides) so the resulting object is safe to JSON-stringify
 * directly.
 */
export function serialiseChunk(c: Chunk): Record<string, unknown> {
  return {
    index: c.index,
    content: c.content,
    cleaned_chunk: c.cleaned_chunk,
    title: c.title,
    context: c.context,
    summary: c.summary,
    keywords: c.keywords,
    questions: c.questions,
    metadata: c.metadata ?? {},
    start: c.start,
    end: c.end,
  }
}
