import type { Dispatch, SetStateAction } from 'react'
import type { ChunkSettings, CloudSettings, ConverterType, VLMSettings } from '../../types'
import type { BulkProgressFn, BulkResultFn } from '../useDocument'

export interface BulkOp {
  title: string
  detail: string
  current: number
  total: number
}

type BatchConvertFn = (
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

interface RunBulkConvertOptions {
  filenames: string[]
  settings: ChunkSettings
  batchConvert: BatchConvertFn
  signal: AbortSignal
  setBulkOp: Dispatch<SetStateAction<BulkOp | null>>
  setBulkConnectionLost: Dispatch<SetStateAction<boolean>>
  showToast: (message: string, type: 'success' | 'error') => void
  onConvertSuccess: (succeededFiles: Set<string>) => Promise<void>
  onProgress: BulkProgressFn
  onResult: BulkResultFn
}

export async function runBulkConvert({
  filenames,
  settings,
  batchConvert,
  signal,
  setBulkOp,
  setBulkConnectionLost,
  showToast,
  onConvertSuccess,
  onProgress,
  onResult,
}: RunBulkConvertOptions): Promise<void> {
  setBulkOp({ title: 'Batch PDF \u2192 Markdown', detail: '', current: 0, total: filenames.length })
  setBulkConnectionLost(false)

  let succeeded = 0
  let failed = 0
  let partial = 0
  const succeededFiles = new Set<string>()

  try {
    await batchConvert(
      filenames,
      settings.converter as ConverterType,
      settings.vlm as VLMSettings | undefined,
      settings.cloud,
      (filename, index, total) => {
        setBulkOp(prev => prev
          ? { ...prev, detail: `File ${index} of ${total} \u2014 ${filename}` }
          : null
        )
      },
      (filename, success, failedPages) => {
        onResult(filename, success, failedPages)
        if (success) {
          succeeded++
          succeededFiles.add(filename)
          if (failedPages && failedPages.length > 0) partial++
        } else {
          failed++
        }
      },
      (current, total, filename, _percentage) => {
        onProgress(current, total, filename)
        setBulkOp(prev => prev ? { ...prev, current } : null)
      },
      signal,
      () => setBulkConnectionLost(true),
      (filename, page, totalPages, fileIndex, fileTotal) => {
        setBulkOp(prev => prev
          ? {
              ...prev,
              detail: `Converting page ${page} of ${totalPages} \u2014 ${filename} (file ${fileIndex} of ${fileTotal})`,
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
  if (succeeded > 0) {
    const cleanCount = succeeded - partial
    if (cleanCount > 0) {
      showToast(`Converted ${cleanCount} file${cleanCount > 1 ? 's' : ''} \u2713`, 'success')
    }
    if (partial > 0) {
      showToast(
        `${partial} file${partial > 1 ? 's' : ''} converted with failed pages \u2014 see \u26a0 in the sidebar`,
        'error',
      )
    }
  }
  if (failed > 0) showToast(`${failed} file${failed > 1 ? 's' : ''} failed to convert`, 'error')

  if (succeeded > 0) await onConvertSuccess(succeededFiles)
}
