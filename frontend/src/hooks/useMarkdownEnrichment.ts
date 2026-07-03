import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnrichmentSettings } from '../types'
import { apiEnrichMarkdownPipeline, type PipelineProgress, type PipelineResult } from '../services/apiService'
import { missingEnrichmentModelError } from '../utils/chunkUtils'

interface UseMarkdownEnrichmentArgs {
  documentName?: string
  mdFilename?: string
  sectionEnrichment?: EnrichmentSettings
  onSaveMarkdown: (content: string) => Promise<void>
  onEnrichSuccess?: (msg: string) => void
  onEnrichError?: (msg: string) => void
}

export function useMarkdownEnrichment({
  documentName,
  mdFilename,
  sectionEnrichment,
  onSaveMarkdown,
  onEnrichSuccess,
  onEnrichError,
}: UseMarkdownEnrichmentArgs) {
  const [enrichError, setEnrichError] = useState<string | null>(null)
  const [summaryModalOpen, setSummaryModalOpen] = useState(false)
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null)
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null)
  const [pipelineSaving, setPipelineSaving] = useState(false)
  const pipelineAbortRef = useRef<AbortController | null>(null)
  const pipelineResultOwnerRef = useRef<string | undefined>(undefined)

  useEffect(() => () => { pipelineAbortRef.current?.abort() }, [])

  useEffect(() => {
    pipelineAbortRef.current?.abort()
    pipelineAbortRef.current = null
    pipelineResultOwnerRef.current = undefined
    setSummaryModalOpen(false)
    setPipelineProgress(null)
    setPipelineResult(null)
    setPipelineSaving(false)
  }, [mdFilename])

  const startPipelineAfterReview = useCallback(async (useSummary: boolean) => {
    if (!documentName || !mdFilename || !sectionEnrichment) return
    const ownerFilename = mdFilename
    pipelineAbortRef.current?.abort()
    const ctrl = new AbortController()
    pipelineAbortRef.current = ctrl

    setPipelineProgress({
      totalPieces: 0,
      completedPieces: 0,
      inFlight: 0,
      cachedPieces: 0,
      failedPieces: [],
    })

    try {
      const useCheckpoint = sectionEnrichment.use_checkpoint ?? true
      const result = await apiEnrichMarkdownPipeline(
        ownerFilename,
        documentName,
        sectionEnrichment,
        useCheckpoint,
        useSummary,
        progress => {
          if (pipelineAbortRef.current === ctrl) setPipelineProgress(progress)
        },
        ctrl.signal,
        () => { /* connection-lost: parseSse aborts the loop; we surface below */ },
      )
      if (pipelineAbortRef.current !== ctrl) return
      pipelineResultOwnerRef.current = ownerFilename
      setPipelineResult(result)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      onEnrichError?.(err instanceof Error ? err.message : 'Pipeline enrichment failed')
    } finally {
      if (pipelineAbortRef.current === ctrl) {
        pipelineAbortRef.current = null
        setPipelineProgress(null)
      }
    }
  }, [sectionEnrichment, documentName, mdFilename, onEnrichError])

  const handleOpenEnrich = useCallback(() => {
    if (!sectionEnrichment?.model) {
      setEnrichError(missingEnrichmentModelError('Section Enrichment'))
      return
    }
    if (!mdFilename) {
      setEnrichError('No Markdown file selected.')
      return
    }
    setEnrichError(null)
    if (sectionEnrichment.skip_summary) {
      startPipelineAfterReview(false)
      return
    }
    setSummaryModalOpen(true)
  }, [sectionEnrichment, mdFilename, startPipelineAfterReview])

  const handleConfirmSummary = useCallback((useSummary: boolean) => {
    setSummaryModalOpen(false)
    startPipelineAfterReview(useSummary)
  }, [startPipelineAfterReview])

  const handleInterruptPipeline = useCallback(() => {
    pipelineAbortRef.current?.abort()
    setPipelineProgress(null)
  }, [])

  const handleAcceptPipeline = useCallback(async (content: string) => {
    if (pipelineResultOwnerRef.current !== mdFilename) {
      setPipelineResult(null)
      onEnrichError?.('The selected Markdown changed before the enriched result was saved.')
      return
    }
    setPipelineSaving(true)
    try {
      await onSaveMarkdown(content)
      onEnrichSuccess?.('Enrichment applied ✓')
      setPipelineResult(null)
      pipelineResultOwnerRef.current = undefined
    } catch {
      onEnrichError?.('Failed to save enriched markdown')
    } finally {
      setPipelineSaving(false)
    }
  }, [mdFilename, onSaveMarkdown, onEnrichSuccess, onEnrichError])

  const handleRejectPipeline = useCallback(() => {
    setPipelineResult(null)
    pipelineResultOwnerRef.current = undefined
  }, [])

  const pipelineCurrent = pipelineProgress?.completedPieces ?? 0
  const pipelineTotal = pipelineProgress?.totalPieces ?? 0
  const pipelineDetail = pipelineProgress
    ? pipelineTotal === 0
      ? 'Cleaning markdown…'
      : `${pipelineCurrent} of ${pipelineTotal} piece${pipelineTotal === 1 ? '' : 's'} corrected` +
        (pipelineProgress.cachedPieces > 0 ? ` · ${pipelineProgress.cachedPieces} from cache` : '') +
        (pipelineProgress.failedPieces.length > 0 ? ` · ${pipelineProgress.failedPieces.length} failed` : '')
    : ''

  return {
    enrichError,
    setEnrichError,
    summaryModalOpen,
    closeSummaryModal: () => setSummaryModalOpen(false),
    pipelineProgress,
    pipelineResult,
    pipelineSaving,
    pipelineCurrent,
    pipelineTotal,
    pipelineDetail,
    handleOpenEnrich,
    handleConfirmSummary,
    handleInterruptPipeline,
    handleAcceptPipeline,
    handleRejectPipeline,
  }
}
