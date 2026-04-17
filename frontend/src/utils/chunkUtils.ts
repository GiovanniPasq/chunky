import type { Chunk } from '../types'

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

/**
 * Returns a user-facing error message when a required `model` field is missing
 * from enrichment settings.  Keeps the wording consistent across hooks.
 */
export function missingEnrichmentModelError(label: string): string {
  return `Configure ${label} (model) in Settings → Enrichment tab.`
}
