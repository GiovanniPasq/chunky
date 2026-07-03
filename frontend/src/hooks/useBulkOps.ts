import { useState, useRef, useCallback, useEffect } from 'react'
import type { ChunkSettings, ConverterType, VLMSettings, CloudSettings } from '../types'
import type { BulkProgressFn, BulkResultFn } from './useDocument'
import { missingEnrichmentModelError } from '../utils/chunkUtils'
import { runBulkConvert } from './bulkOps/runBulkConvert'
import type { BulkOp } from './bulkOps/runBulkConvert'
import { runBulkChunk } from './bulkOps/runBulkChunk'
import { runBulkMarkdownEnrich } from './bulkOps/runBulkMarkdownEnrich'
import { runBulkChunkEnrich } from './bulkOps/runBulkChunkEnrich'
import {
  resolveBulkChunkMarkdownFilename,
  resolvePreferredMarkdownFilename,
} from './bulkOps/markdownResolution'

interface Options {
  batchConvert: (
    filenames: string[],
    converter: ConverterType,
    vlm: VLMSettings | undefined,
    cloud: CloudSettings | undefined,
    onFileStart: (filename: string, index: number, total: number) => void,
    onFileResult: (filename: string, success: boolean, failedPages?: number[]) => void,
    onBatchProgress: (current: number, total: number, filename: string, percentage: number) => void,
    signal?: AbortSignal,
    onConnectionLost?: () => void,
    onPageProgress?: (filename: string, page: number, totalPages: number, fileIndex: number, fileTotal: number) => void,
  ) => Promise<void>
  settings: ChunkSettings
  showToast: (message: string, type: 'success' | 'error') => void
  onConvertSuccess: (succeededFiles: Set<string>) => Promise<void>
  onMarkdownEnrichSuccess: (succeededFiles: Set<string>) => Promise<void>
  onChunkArtifactsChanged: (succeededFiles: Set<string>) => Promise<void>
}

export function useBulkOps({
  batchConvert,
  settings,
  showToast,
  onConvertSuccess,
  onMarkdownEnrichSuccess,
  onChunkArtifactsChanged,
}: Options) {
  const [bulkOp, setBulkOp] = useState<BulkOp | null>(null)
  const [bulkConnectionLost, setBulkConnectionLost] = useState(false)
  const bulkAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    bulkAbortRef.current?.abort()
  }, [])

  const interruptBulk = useCallback(() => {
    bulkAbortRef.current?.abort()
    setBulkConnectionLost(false)
  }, [])

  const handleBulkConvert = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()
    await runBulkConvert({
      filenames,
      settings,
      batchConvert,
      signal: bulkAbortRef.current.signal,
      setBulkOp,
      setBulkConnectionLost,
      showToast,
      onConvertSuccess,
      onProgress,
      onResult,
    })
  }, [batchConvert, settings, showToast, onConvertSuccess])

  const handleBulkChunk = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()
    const { signal } = bulkAbortRef.current

    await runBulkChunk({
      filenames,
      settings,
      signal,
      setBulkOp,
      setBulkConnectionLost,
      showToast,
      resolveMarkdownFilename: resolveBulkChunkMarkdownFilename,
      onSuccess: onChunkArtifactsChanged,
      onProgress,
      onResult,
    })
  }, [settings, showToast, onChunkArtifactsChanged])

  // ── Bulk markdown enrichment ─────────────────────────────────────────────
  //
  // Iterates the selected PDF filenames one at a time, picks the
  // highest-priority markdown variant present for each, runs the
  // enrichment pipeline against it, and persists the corrected output.
  // Each pipeline call uses whatever document summary is already cached
  // on disk — bulk DOES NOT open the SummaryReviewModal (the user
  // confirmed "bulk skip" — the curated review path is reserved for
  // single-doc enrichment).  Files with no markdown are skipped with a
  // failure result; per-file failures never abort the rest of the run.
  //
  // We always pass ``use_summary=true`` so the backend silently
  // attaches a cached summary when one exists.  The per-doc
  // ``skip_summary`` setting only affects the single-doc modal flow —
  // honoring it here would couple bulk to UI state that isn't visible
  // in the bulk context.
  const handleBulkEnrich = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    const enrichSettings = settings.sectionEnrichment
    if (!enrichSettings?.model) {
      showToast('Section Enrichment model is not configured', 'error')
      filenames.forEach(f => onResult(f, false))
      return
    }

    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()
    const { signal } = bulkAbortRef.current

    await runBulkMarkdownEnrich({
      filenames,
      enrichSettings,
      signal,
      setBulkOp,
      setBulkConnectionLost,
      showToast,
      resolveMarkdownFilename: resolvePreferredMarkdownFilename,
      onSuccess: onMarkdownEnrichSuccess,
      onProgress,
      onResult,
    })
  }, [settings.sectionEnrichment, showToast, onMarkdownEnrichSuccess])

  const handleBulkChunkEnrich = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    const enrichSettings = settings.chunkEnrichment
    if (!enrichSettings?.model) {
      showToast(missingEnrichmentModelError('Chunk Enrichment settings'), 'error')
      filenames.forEach(f => onResult(f, false))
      return
    }

    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()
    const { signal } = bulkAbortRef.current

    await runBulkChunkEnrich({
      filenames,
      settings,
      enrichSettings,
      signal,
      setBulkOp,
      setBulkConnectionLost,
      showToast,
      resolveMarkdownFilename: resolveBulkChunkMarkdownFilename,
      onSuccess: onChunkArtifactsChanged,
      onProgress,
      onResult,
    })
  }, [settings, settings.chunkEnrichment, showToast, onChunkArtifactsChanged])

  return {
    bulkOp,
    bulkConnectionLost,
    interruptBulk,
    handleBulkConvert,
    handleBulkChunk,
    handleBulkEnrich,
    handleBulkChunkEnrich,
  }
}
