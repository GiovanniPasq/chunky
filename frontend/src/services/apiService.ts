import type { Capabilities, EnrichmentSettings } from '../types'
import { parseSse } from '../utils/parseSse'

export const API_BASE = '/api'

/**
 * Build the request body for enrichment endpoints.
 * Applies defaults for optional fields so callers don't need to repeat them.
 */
export function buildEnrichmentBody(
  settings: EnrichmentSettings,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    settings: {
      model: settings.model,
      base_url: settings.base_url ?? 'http://localhost:11434/v1',
      api_key: settings.api_key ?? 'ollama',
      temperature: settings.temperature ?? 0.3,
      user_prompt: settings.user_prompt,
    },
  }
}

export const capabilityService = {
  async get(): Promise<Capabilities> {
    const res = await fetch(`${API_BASE}/capabilities`)
    if (!res.ok) throw new Error('Failed to fetch capabilities')
    return res.json()
  },
}

/**
 * Enrich a single markdown section via SSE.
 * Returns the enriched content string.
 * Throws on error; throws DOMException(AbortError) if cancelled/aborted.
 */
export async function apiEnrichMarkdown(
  settings: EnrichmentSettings,
  content: string,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
): Promise<string> {
  const res = await fetch(`${API_BASE}/enrich/markdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, { content })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Enrichment failed ${res.status}: ${errText}`)
  }
  if (!res.body) throw new Error('No response body')
  for await (const event of parseSse(res.body, onConnectionLost)) {
    if (event.type === 'done') return event.enriched_content as string
    if (event.type === 'error') throw new Error(String(event.message ?? 'Enrichment error'))
    if (event.type === 'cancelled') throw new DOMException('Enrichment cancelled', 'AbortError')
  }
  throw new Error('Stream ended without a done event')
}

/**
 * Enrich a single chunk via SSE (sends a one-item batch).
 * Returns the enriched chunk fields as a plain object.
 * Throws on error; throws DOMException(AbortError) if cancelled/aborted.
 */
export async function apiEnrichChunk(
  settings: EnrichmentSettings,
  index: number,
  content: string,
  start: number,
  end: number,
  metadata: Record<string, unknown>,
  signal?: AbortSignal,
  onConnectionLost?: () => void,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/enrich/chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(buildEnrichmentBody(settings, {
      chunks: [{ index, content, start, end, metadata }],
    })),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`Chunk enrichment failed ${res.status}: ${errText}`)
  }
  if (!res.body) throw new Error('No response body')
  for await (const event of parseSse(res.body, onConnectionLost)) {
    if (event.type === 'chunk_done') return event.chunk as Record<string, unknown>
    if (event.type === 'error') throw new Error(String(event.message ?? 'Chunk enrichment error'))
    if (event.type === 'cancelled') throw new DOMException('Chunk enrichment cancelled', 'AbortError')
  }
  throw new Error('Stream ended without a done event')
}
