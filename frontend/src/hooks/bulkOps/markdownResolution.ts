import type { ChunkSettings } from '../../types'
import { converterFilenameToken } from '../../services/apiService'
import { listMarkdownVersions } from '../../services/markdownsApi'

const BULK_ENRICH_CONVERTER_PRIORITY = ['vlm', 'cloud', 'docling', 'markitdown', 'liteparse', 'pymupdf4llm']

export async function resolvePreferredMarkdownFilename(filename: string): Promise<string | null> {
  const versions = await listMarkdownVersions(filename)
  const converted = versions.filter(version => version.source === 'converted' && version.converter)
  for (const token of BULK_ENRICH_CONVERTER_PRIORITY) {
    const hit = converted.find(version => version.converter === token)
    if (hit) return hit.filename
  }
  if (converted.length > 0) return converted[0].filename
  return versions.find(version => version.source === 'uploaded')?.filename ?? null
}

export async function resolveBulkChunkMarkdownFilename(
  filename: string,
  settings: ChunkSettings,
): Promise<string | null> {
  const versions = await listMarkdownVersions(filename)
  if (versions.length === 0) return null
  if (settings.useFirstMarkdownForBulkChunks) return versions[0].filename

  const token = converterFilenameToken(settings.converter)
  if (token) {
    const converted = versions.find(version => version.source === 'converted' && version.converter === token)
    if (converted) return converted.filename
  }

  const uploadedOnly = versions.every(version => version.source === 'uploaded')
  return uploadedOnly ? versions[0].filename : null
}
