import { useState, useRef, useCallback } from 'react'
import type { ChunkSettings, ConverterType, VLMSettings, CloudSettings } from '../types'
import type { BulkProgressFn, BulkResultFn } from './useDocument'
import { consumeChunkSse } from '../utils/consumeChunkSse'
import { CONNECTION_LOST_MSG } from '../utils/parseSse'

export interface BulkOp {
  title: string
  detail: string
  current: number
  total: number
}

interface Options {
  batchConvert: (
    filenames: string[],
    converter: ConverterType,
    vlm: VLMSettings | undefined,
    cloud: CloudSettings | undefined,
    onFileStart: (filename: string, index: number, total: number) => void,
    onFileResult: (filename: string, success: boolean) => void,
    onBatchProgress: (current: number, total: number, filename: string, percentage: number) => void,
    signal?: AbortSignal,
    onConnectionLost?: () => void,
    onPageProgress?: (filename: string, page: number, totalPages: number, fileIndex: number, fileTotal: number) => void,
  ) => Promise<void>
  settings: ChunkSettings
  showToast: (message: string, type: 'success' | 'error') => void
  onConvertSuccess: (succeededFiles: Set<string>) => Promise<void>
}

export function useBulkOps({
  batchConvert,
  settings,
  showToast,
  onConvertSuccess,
}: Options) {
  const [bulkOp, setBulkOp] = useState<BulkOp | null>(null)
  const [bulkConnectionLost, setBulkConnectionLost] = useState(false)
  const bulkAbortRef = useRef<AbortController | null>(null)

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

    setBulkOp({ title: 'Batch PDF → Markdown', detail: '', current: 0, total: filenames.length })
    setBulkConnectionLost(false)

    let succeeded = 0
    let failed = 0
    const succeededFiles = new Set<string>()

    try {
      await batchConvert(
        filenames,
        settings.converter as ConverterType,
        settings.vlm as VLMSettings | undefined,
        settings.cloud,
        (filename, index, total) => {
          setBulkOp(prev => prev
            ? { ...prev, detail: `File ${index} of ${total} — ${filename}` }
            : null
          )
        },
        (filename, success) => {
          onResult(filename, success)
          if (success) { succeeded++; succeededFiles.add(filename) }
          else failed++
        },
        (current, total, filename, _percentage) => {
          onProgress(current, total, filename)
          setBulkOp(prev => prev ? { ...prev, current } : null)
        },
        bulkAbortRef.current.signal,
        () => setBulkConnectionLost(true),
        (filename, page, totalPages, fileIndex, fileTotal) => {
          setBulkOp(prev => prev
            ? {
                ...prev,
                detail: `Converting page ${page} of ${totalPages} — ${filename} (file ${fileIndex} of ${fileTotal})`,
              }
            : null
          )
        },
      )
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        showToast(err instanceof Error ? err.message : 'Batch conversion failed', 'error')
        setBulkOp(null)
        setBulkConnectionLost(false)
        return
      }
    }

    setBulkOp(null)
    setBulkConnectionLost(false)
    if (succeeded > 0) showToast(`Converted ${succeeded} file${succeeded > 1 ? 's' : ''} ✓`, 'success')
    if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to convert`, 'error')

    if (succeeded > 0) await onConvertSuccess(succeededFiles)
  }, [batchConvert, settings, showToast, onConvertSuccess])

  const handleBulkChunk = useCallback(async (
    filenames: string[],
    onProgress: BulkProgressFn,
    onResult: BulkResultFn,
  ) => {
    bulkAbortRef.current?.abort()
    bulkAbortRef.current = new AbortController()
    const { signal } = bulkAbortRef.current

    setBulkOp({ title: 'Batch Chunking', detail: '', current: 0, total: filenames.length })

    let succeeded = 0
    let failed = 0

    const onFileStart = (filename: string, index: number, total: number) => {
      onProgress(index, total, filename)
      setBulkOp(prev => prev
        ? { ...prev, detail: `File ${index} of ${total} — ${filename}`, current: index }
        : null
      )
    }

    const onFileDone = (filename: string, success: boolean) => {
      onResult(filename, success)
      if (success) succeeded++
      else failed++
    }

    try {
      await consumeChunkSse(
        filenames,
        settings,
        signal,
        () => setBulkConnectionLost(true),
        onFileStart,
        onFileDone,
      )
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        showToast(err instanceof Error ? err.message : 'Batch chunking failed', 'error')
      }
    }

    setBulkOp(null)
    setBulkConnectionLost(false)
    if (succeeded > 0) showToast(`Chunked ${succeeded} file${succeeded > 1 ? 's' : ''} ✓`, 'success')
    if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to chunk`, 'error')
  }, [settings, showToast])

  return { bulkOp, bulkConnectionLost, interruptBulk, handleBulkConvert, handleBulkChunk }
}
