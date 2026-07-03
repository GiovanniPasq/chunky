import type { Dispatch, SetStateAction } from 'react'
import type { Chunk, ChunkSettings, EnrichmentSettings } from '../../types'
import type { BulkProgressFn, BulkResultFn } from '../useDocument'
import { apiEnrichChunks } from '../../services/apiService'
import {
  chunkSse,
  listChunksVersions,
  loadSavedChunksFile,
  saveChunks as saveChunksApi,
} from '../../services/chunksApi'
import { isChunksVersionForSettings } from '../../utils/chunkUtils'
import type { BulkOp } from './runBulkConvert'

interface RunBulkChunkEnrichOptions {
  filenames: string[]
  settings: ChunkSettings
  enrichSettings: EnrichmentSettings
  signal: AbortSignal
  setBulkOp: Dispatch<SetStateAction<BulkOp | null>>
  setBulkConnectionLost: Dispatch<SetStateAction<boolean>>
  showToast: (message: string, type: 'success' | 'error') => void
  resolveMarkdownFilename: (filename: string, settings: ChunkSettings) => Promise<string | null>
  onSuccess: (succeededFiles: Set<string>) => Promise<void>
  onProgress: BulkProgressFn
  onResult: BulkResultFn
}

export async function runBulkChunkEnrich({
  filenames,
  settings,
  enrichSettings,
  signal,
  setBulkOp,
  setBulkConnectionLost,
  showToast,
  resolveMarkdownFilename,
  onSuccess,
  onProgress,
  onResult,
}: RunBulkChunkEnrichOptions): Promise<void> {
  setBulkOp({ title: 'Batch Chunk Enrichment', detail: '', current: 0, total: filenames.length })
  setBulkConnectionLost(false)

  let succeeded = 0
  let failed = 0
  let partial = 0
  let skippedNoMd = 0
  let saveFailed = 0
  let lookupFailed = 0
  const succeededFiles = new Set<string>()

  for (let i = 0; i < filenames.length; i++) {
    if (signal.aborted) break
    const filename = filenames[i]
    const fileIndex = i + 1
    onProgress(fileIndex, filenames.length, filename)
    setBulkOp(prev => prev
      ? { ...prev, current: fileIndex, detail: `File ${fileIndex} of ${filenames.length} \u2014 ${filename}` }
      : null
    )

    let chunks: Chunk[] | null = null
    let mdFilename: string | null = null
    let sourceHash: string | null = null

    try {
      mdFilename = await resolveMarkdownFilename(filename, settings)
    } catch (err) {
      lookupFailed++
      console.warn(`Bulk chunk enrichment: markdown resolution failed for '${filename}':`, err)
      onResult(filename, false)
      continue
    }
    if (!mdFilename) {
      skippedNoMd++
      onResult(filename, false)
      continue
    }

    try {
      const versions = await listChunksVersions(filename)
      const matching = versions.find(version =>
        version.md_filename === mdFilename && isChunksVersionForSettings(version, settings)
      )
      if (matching) {
        setBulkOp(prev => prev
          ? { ...prev, detail: `File ${fileIndex} of ${filenames.length} \u2014 loading saved chunks for ${filename}` }
          : null
        )
        const loaded = await loadSavedChunksFile(filename, matching.filename, signal)
        chunks = loaded.chunks
        sourceHash = loaded.sourceHash
        mdFilename = matching.md_filename
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') break
      console.warn(`Bulk chunk enrichment: saved chunk lookup failed for '${filename}', will try fresh chunking:`, err)
      chunks = null
    }

    if (!chunks) {
      try {
        setBulkOp(prev => prev
          ? { ...prev, detail: `File ${fileIndex} of ${filenames.length} \u2014 chunking ${filename}` }
          : null
        )
        const generated = await chunkSse(
          [filename],
          settings,
          signal,
          () => setBulkConnectionLost(true),
          undefined,
          undefined,
          mdFilename,
        )
        chunks = generated.chunks
        sourceHash = generated.sourceHash
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break
        failed++
        console.warn(`Bulk chunk enrichment: chunking failed for '${filename}':`, err)
        onResult(filename, false)
        continue
      }
    }

    if (!chunks || chunks.length === 0) {
      failed++
      onResult(filename, false)
      continue
    }

    try {
      const result = await apiEnrichChunks(
        enrichSettings,
        chunks,
        mdFilename,
        filename,
        signal,
        ({ current, total }) => {
          setBulkOp(prev => prev
            ? {
                ...prev,
                detail: `File ${fileIndex} of ${filenames.length} \u2014 enriching ${current}/${total} chunks (${filename})`,
              }
            : null
          )
        },
        () => setBulkConnectionLost(true),
      )

      if (result.succeeded === 0) {
        failed++
        onResult(filename, false)
        continue
      }

      const enrichedByIndex = new Map(result.chunks.map(chunk => [chunk.index, chunk]))
      const merged = chunks.map(chunk => {
        const enriched = enrichedByIndex.get(chunk.index)
        return enriched ? { ...chunk, ...enriched } : chunk
      })

      try {
        setBulkOp(prev => prev
          ? { ...prev, detail: `File ${fileIndex} of ${filenames.length} \u2014 saving enriched chunks for ${filename}` }
          : null
        )
        await saveChunksApi({
          filename,
          mdFilename,
          sourceHash,
          settings,
          chunks: merged,
        }, signal)
        succeeded++
        succeededFiles.add(filename)
        if (result.failed > 0) partial++
        onResult(filename, true)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break
        saveFailed++
        console.warn(`Bulk chunk enrichment: save failed for '${filename}':`, err)
        onResult(filename, false)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') break
      failed++
      console.warn(`Bulk chunk enrichment failed for '${filename}':`, err)
      onResult(filename, false)
    }
  }

  setBulkOp(null)
  setBulkConnectionLost(false)
  if (succeeded > 0) showToast(`Enriched chunks for ${succeeded} file${succeeded > 1 ? 's' : ''} \u2713`, 'success')
  if (partial > 0) showToast(`${partial} file${partial > 1 ? 's' : ''} saved with some chunk failures`, 'error')
  if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed chunk enrichment`, 'error')
  if (saveFailed > 0) showToast(`${saveFailed} file${saveFailed > 1 ? 's' : ''} enriched but not saved`, 'error')
  if (lookupFailed > 0) {
    showToast(`${lookupFailed} file${lookupFailed > 1 ? 's' : ''} failed while checking Markdown versions`, 'error')
  }
  if (skippedNoMd > 0) showToast(`${skippedNoMd} file${skippedNoMd > 1 ? 's' : ''} skipped \u2014 no markdown found`, 'error')

  if (succeededFiles.size > 0) await onSuccess(succeededFiles)
}
