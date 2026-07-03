import type { Dispatch, SetStateAction } from 'react'
import type { EnrichmentSettings } from '../../types'
import type { BulkProgressFn, BulkResultFn } from '../useDocument'
import { apiEnrichMarkdownPipeline } from '../../services/apiService'
import { saveMarkdownFile } from '../../services/documentsApi'
import type { BulkOp } from './runBulkConvert'

interface RunBulkMarkdownEnrichOptions {
  filenames: string[]
  enrichSettings: EnrichmentSettings
  signal: AbortSignal
  setBulkOp: Dispatch<SetStateAction<BulkOp | null>>
  setBulkConnectionLost: Dispatch<SetStateAction<boolean>>
  showToast: (message: string, type: 'success' | 'error') => void
  resolveMarkdownFilename: (filename: string) => Promise<string | null>
  onSuccess: (succeededFiles: Set<string>) => Promise<void>
  onProgress: BulkProgressFn
  onResult: BulkResultFn
}

export async function runBulkMarkdownEnrich({
  filenames,
  enrichSettings,
  signal,
  setBulkOp,
  setBulkConnectionLost,
  showToast,
  resolveMarkdownFilename,
  onSuccess,
  onProgress,
  onResult,
}: RunBulkMarkdownEnrichOptions): Promise<void> {
  setBulkOp({ title: 'Batch Markdown Enrichment', detail: '', current: 0, total: filenames.length })
  setBulkConnectionLost(false)

  let succeeded = 0
  let partial = 0
  let failed = 0
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

    let mdFilename: string | null = null
    try {
      mdFilename = await resolveMarkdownFilename(filename)
    } catch (err) {
      lookupFailed++
      console.warn(`Bulk enrich: variant resolution failed for '${filename}':`, err)
      onResult(filename, false)
      continue
    }

    if (!mdFilename) {
      skippedNoMd++
      onResult(filename, false)
      continue
    }

    try {
      const result = await apiEnrichMarkdownPipeline(
        mdFilename,
        filename,
        enrichSettings,
        enrichSettings.use_checkpoint ?? true,
        true,
        (progress) => {
          const detail = progress.totalPieces === 0
            ? `File ${fileIndex} of ${filenames.length} \u2014 ${filename} (cleaning\u2026)`
            : `File ${fileIndex} of ${filenames.length} \u2014 ${filename} (${progress.completedPieces}/${progress.totalPieces} pieces)`
          setBulkOp(prev => prev ? { ...prev, detail } : null)
        },
        signal,
        () => setBulkConnectionLost(true),
      )

      try {
        await saveMarkdownFile(filename, mdFilename, result.enrichedContent, signal)
        succeeded++
        succeededFiles.add(filename)
        if (result.stats.failed_pieces.length > 0) partial++
        onResult(filename, true)
      } catch (saveErr) {
        if (saveErr instanceof DOMException && saveErr.name === 'AbortError') break
        saveFailed++
        console.warn(`Bulk enrich: save failed for '${mdFilename}':`, saveErr)
        onResult(filename, false)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') break
      failed++
      console.warn(`Bulk enrich: pipeline failed for '${mdFilename}':`, err)
      onResult(filename, false)
    }
  }

  setBulkOp(null)
  setBulkConnectionLost(false)
  if (succeeded > 0) showToast(`Enriched ${succeeded} file${succeeded > 1 ? 's' : ''} \u2713`, 'success')
  if (partial > 0) {
    showToast(
      `${partial} file${partial > 1 ? 's' : ''} saved with uncorrected pieces after LLM failures`,
      'error',
    )
  }
  if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to enrich`, 'error')
  if (saveFailed > 0) showToast(`${saveFailed} file${saveFailed > 1 ? 's' : ''} enriched but not saved`, 'error')
  if (lookupFailed > 0) {
    showToast(`${lookupFailed} file${lookupFailed > 1 ? 's' : ''} failed while checking Markdown versions`, 'error')
  }
  if (skippedNoMd > 0) showToast(`${skippedNoMd} file${skippedNoMd > 1 ? 's' : ''} skipped \u2014 no markdown found`, 'error')

  if (succeededFiles.size > 0) await onSuccess(succeededFiles)
}
