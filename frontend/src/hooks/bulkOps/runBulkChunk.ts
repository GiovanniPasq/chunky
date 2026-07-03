import type { Dispatch, SetStateAction } from 'react'
import type { ChunkSettings } from '../../types'
import type { BulkProgressFn, BulkResultFn } from '../useDocument'
import { chunkSse, saveChunks as saveChunksApi } from '../../services/chunksApi'
import type { BulkOp } from './runBulkConvert'

interface RunBulkChunkOptions {
  filenames: string[]
  settings: ChunkSettings
  signal: AbortSignal
  setBulkOp: Dispatch<SetStateAction<BulkOp | null>>
  setBulkConnectionLost: Dispatch<SetStateAction<boolean>>
  showToast: (message: string, type: 'success' | 'error') => void
  resolveMarkdownFilename: (filename: string, settings: ChunkSettings) => Promise<string | null>
  onSuccess: (succeededFiles: Set<string>) => Promise<void>
  onProgress: BulkProgressFn
  onResult: BulkResultFn
}

export async function runBulkChunk({
  filenames,
  settings,
  signal,
  setBulkOp,
  setBulkConnectionLost,
  showToast,
  resolveMarkdownFilename,
  onSuccess,
  onProgress,
  onResult,
}: RunBulkChunkOptions): Promise<void> {
  setBulkOp({ title: 'Batch Chunking', detail: '', current: 0, total: filenames.length })
  setBulkConnectionLost(false)

  let succeeded = 0
  let failed = 0
  let saveFailed = 0
  let skippedNoMd = 0
  let lookupFailed = 0
  const succeededFiles = new Set<string>()

  for (let i = 0; i < filenames.length; i++) {
    if (signal.aborted) break
    const filename = filenames[i]
    const fileIndex = i + 1
    onProgress(fileIndex, filenames.length, filename)
    setBulkOp(prev => prev
      ? { ...prev, detail: `File ${fileIndex} of ${filenames.length} \u2014 ${filename}`, current: fileIndex }
      : null
    )

    let mdFilename: string | null = null
    try {
      mdFilename = await resolveMarkdownFilename(filename, settings)
    } catch (err) {
      lookupFailed++
      console.warn(`Bulk chunking: markdown resolution failed for '${filename}':`, err)
      onResult(filename, false)
      continue
    }
    if (!mdFilename) {
      skippedNoMd++
      onResult(filename, false)
      continue
    }

    try {
      const result = await chunkSse(
        [filename],
        settings,
        signal,
        () => setBulkConnectionLost(true),
        undefined,
        undefined,
        mdFilename,
      )
      try {
        await saveChunksApi({
          filename,
          mdFilename,
          sourceHash: result.sourceHash,
          settings,
          chunks: result.chunks,
        }, signal)
        succeeded++
        succeededFiles.add(filename)
        onResult(filename, true)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break
        saveFailed++
        console.warn(`Failed to save chunks for '${filename}':`, err)
        onResult(filename, false)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') break
      failed++
      console.warn(`Bulk chunking failed for '${filename}':`, err)
      onResult(filename, false)
    }
  }

  setBulkOp(null)
  setBulkConnectionLost(false)
  if (succeeded > 0) showToast(`Chunked ${succeeded} file${succeeded > 1 ? 's' : ''} \u2713`, 'success')
  if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to chunk`, 'error')
  if (saveFailed > 0) showToast(`${saveFailed} file${saveFailed > 1 ? 's' : ''} chunked but not saved`, 'error')
  if (lookupFailed > 0) {
    showToast(`${lookupFailed} file${lookupFailed > 1 ? 's' : ''} failed while checking Markdown versions`, 'error')
  }
  if (skippedNoMd > 0) {
    showToast(`${skippedNoMd} file${skippedNoMd > 1 ? 's' : ''} skipped \u2014 selected Markdown variant not found`, 'error')
  }

  if (succeededFiles.size > 0) await onSuccess(succeededFiles)
}
