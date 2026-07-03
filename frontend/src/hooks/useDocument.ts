import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  DocumentData,
  ConverterType,
  VLMSettings,
  CloudSettings,
  MarkdownVersion,
  ChunksVersion,
} from '../types'
import { parseSse, CONNECTION_LOST_MSG } from '../utils/parseSse'
import { API_BASE } from '../services/apiService'
import {
  convertMarkdownToPdf,
  deleteMarkdownVariant,
  deleteDocumentsByName,
  getDocument,
  listDocuments,
  saveMarkdownFile,
  summariseUploadResponse,
  uploadDocumentFiles,
} from '../services/documentsApi'
import { listMarkdownVersions, getMarkdownContent } from '../services/markdownsApi'
import { listChunksVersions } from '../services/chunksApi'

export type BulkProgressFn = (current: number, total: number, filename: string) => void
export type BulkResultFn = (filename: string, success: boolean, failedPages?: number[]) => void

const API = API_BASE

export interface ToastCallbacks {
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}

export interface ConversionProgress {
  current: number
  total: number
}

// ─────────────────────────────────────────────────────────────
// useDocument
// ─────────────────────────────────────────────────────────────
export function useDocument(toast: ToastCallbacks) {
  const [documents, setDocuments] = useState<string[]>([])
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [documentData, setDocumentData] = useState<DocumentData | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [converting, setConverting] = useState(false)
  const [convertingToPdf, setConvertingToPdf] = useState(false)
  const [savingMd, setSavingMd] = useState(false)
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null)
  const [conversionErrorMessage, setConversionErrorMessage] = useState<string | null>(null)

  // ── Versioned markdowns / chunks ────────────────────────────────────────────
  // Lists of every saved Markdown / chunks version for the active document.
  // The "selected" identifiers track which version is currently displayed in
  // the viewer; defaults to the first available entry on document switch.
  const [availableMarkdowns, setAvailableMarkdowns] = useState<MarkdownVersion[]>([])
  const [availableChunks, setAvailableChunks] = useState<ChunksVersion[]>([])
  const [selectedMarkdown, setSelectedMarkdown] = useState<string | null>(null)
  const [selectedChunks, setSelectedChunks] = useState<string | null>(null)

  // Keep latest toast in a ref so all stable useCallback closures always
  // call the current toast functions without needing them as dependencies.
  const toastRef = useRef<ToastCallbacks>(toast)
  toastRef.current = toast

  // Track the currently selected filename and document data in refs so callbacks
  // always see the latest values without needing them in their dependency arrays.
  const selectedDocRef = useRef<string | null>(null)
  selectedDocRef.current = selectedDoc
  const documentDataRef = useRef<DocumentData | null>(null)
  documentDataRef.current = documentData

  // AbortControllers for in-flight requests
  const fetchDocAbortRef = useRef<AbortController | null>(null)
  const markdownVersionAbortRef = useRef<AbortController | null>(null)
  const convertAbortRef = useRef<AbortController | null>(null)
  const convertToPdfAbortRef = useRef<AbortController | null>(null)
  const versionsRequestRef = useRef(0)
  const markdownSelectionRef = useRef(0)

  useEffect(() => () => {
    fetchDocAbortRef.current?.abort()
    markdownVersionAbortRef.current?.abort()
    convertAbortRef.current?.abort()
    convertToPdfAbortRef.current?.abort()
  }, [])

  const fetchDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments())
    } catch {
      toastRef.current.onError('Failed to fetch document list')
    }
  }, [])

  useEffect(() => { fetchDocuments() }, [fetchDocuments])

  /**
   * Fetch the markdowns + chunks version lists for the active document.
   * Returns the markdowns array so callers can sync ``selectedMarkdown``
   * with the resolved default (matching the md_filename returned by
   * ``GET /document/{filename}``).
   */
  const fetchVersions = useCallback(async (filename: string): Promise<MarkdownVersion[]> => {
    const requestId = ++versionsRequestRef.current
    const [markdownResult, chunksResult] = await Promise.allSettled([
      listMarkdownVersions(filename),
      listChunksVersions(filename),
    ])
    if (markdownResult.status === 'rejected') throw markdownResult.reason
    const mdVersions = markdownResult.value
    if (
      selectedDocRef.current === filename &&
      versionsRequestRef.current === requestId
    ) {
      setAvailableMarkdowns(mdVersions)
      if (chunksResult.status === 'fulfilled') {
        setAvailableChunks(chunksResult.value)
      }
    }
    return mdVersions
  }, [])

  const syncSelectedMarkdownFromVersions = useCallback(async (
    filename: string,
    preferredFilename: string,
    fallback: 'first' | 'preferred' = 'first',
  ) => {
    const selectionId = ++markdownSelectionRef.current
    try {
      const versions = await fetchVersions(filename)
      if (
        selectedDocRef.current !== filename ||
        markdownSelectionRef.current !== selectionId
      ) return
      const match = versions.find(v => v.filename === preferredFilename)
      setSelectedMarkdown(
        match?.filename ??
        (fallback === 'preferred' ? preferredFilename : versions[0]?.filename ?? null),
      )
    } catch {
      // Version lists are advisory UI state; failed refreshes should not break
      // the document load/conversion flow that already succeeded.
    }
  }, [fetchVersions])

  /** Replace the currently displayed Markdown with another available version. */
  const selectMarkdownVersion = useCallback(async (identifier: string) => {
    const filename = selectedDocRef.current
    if (!filename) return

    fetchDocAbortRef.current?.abort()
    markdownVersionAbortRef.current?.abort()
    const selectionId = ++markdownSelectionRef.current
    const abortCtrl = new AbortController()
    markdownVersionAbortRef.current = abortCtrl

    try {
      const data = await getMarkdownContent(filename, identifier, abortCtrl.signal)
      if (
        markdownVersionAbortRef.current !== abortCtrl ||
        selectedDocRef.current !== filename ||
        markdownSelectionRef.current !== selectionId
      ) return
      setSelectedMarkdown(data.filename)
      setDocumentData(prev => prev ? { ...prev, md_filename: data.filename, md_content: data.content, has_markdown: true } : prev)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError('Failed to load Markdown version')
    } finally {
      if (markdownVersionAbortRef.current === abortCtrl) {
        markdownVersionAbortRef.current = null
      }
    }
  }, [])

  /** Re-fetch document data for the currently selected document (e.g. after batch conversion). */
  const refreshDocument = useCallback(async () => {
    const filename = selectedDocRef.current
    if (!filename) return

    fetchDocAbortRef.current?.abort()
    markdownVersionAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    fetchDocAbortRef.current = abortCtrl

    setLoading(true)
    try {
      const data = await getDocument(filename, abortCtrl.signal)
      if (fetchDocAbortRef.current !== abortCtrl || selectedDocRef.current !== filename) return
      setDocumentData(data)
      void syncSelectedMarkdownFromVersions(filename, data.md_filename)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    } finally {
      if (fetchDocAbortRef.current === abortCtrl) setLoading(false)
    }
  }, [syncSelectedMarkdownFromVersions])

  const selectDocument = useCallback(async (filename: string) => {
    if (filename === selectedDocRef.current) return

    fetchDocAbortRef.current?.abort()
    markdownVersionAbortRef.current?.abort()
    versionsRequestRef.current += 1
    markdownSelectionRef.current += 1
    const abortCtrl = new AbortController()
    fetchDocAbortRef.current = abortCtrl

    convertAbortRef.current?.abort()
    convertToPdfAbortRef.current?.abort()
    setConverting(false)
    setConvertingToPdf(false)
    setConversionErrorMessage(null)

    setSelectedDoc(filename)
    setDocumentData(null)
    setAvailableMarkdowns([])
    setAvailableChunks([])
    setSelectedMarkdown(null)
    setSelectedChunks(null)
    setLoading(true)
    try {
      const data = await getDocument(filename, abortCtrl.signal)
      if (fetchDocAbortRef.current !== abortCtrl || selectedDocRef.current !== filename) return
      setDocumentData(data)
      // Kick off the version-list fetch in parallel; doesn't block first paint.
      void syncSelectedMarkdownFromVersions(filename, data.md_filename)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError(`Failed to load "${filename}"`)
    } finally {
      if (fetchDocAbortRef.current === abortCtrl) setLoading(false)
    }
  }, [syncSelectedMarkdownFromVersions])

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const response = await uploadDocumentFiles(files)
      if (response.uploaded > 0) await fetchDocuments()
      const message = summariseUploadResponse(response)
      if (response.failed > 0) {
        toastRef.current.onError(message)
      } else {
        toastRef.current.onSuccess(message)
      }
    } catch (err) {
      toastRef.current.onError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [fetchDocuments])

  const deleteDocuments = useCallback(async (filenames: string[]) => {
    if (filenames.length === 0) {
      return { success: true, deleted: [], deleted_documents: [], failed: {}, message: '' }
    }
    try {
      const result = await deleteDocumentsByName(filenames)
      if (
        selectedDocRef.current &&
        result.deleted_documents.includes(selectedDocRef.current)
      ) {
        fetchDocAbortRef.current?.abort()
        markdownVersionAbortRef.current?.abort()
        convertAbortRef.current?.abort()
        convertToPdfAbortRef.current?.abort()
        setConverting(false)
        setConvertingToPdf(false)
        setSelectedDoc(null)
        setDocumentData(null)
        setAvailableMarkdowns([])
        setAvailableChunks([])
        setSelectedMarkdown(null)
        setSelectedChunks(null)
      }
      await fetchDocuments()
      const deletedCount = result.deleted_documents.length
      const failedCount = Object.keys(result.failed).length
      if (deletedCount > 0) {
        toastRef.current.onSuccess(
          `Deleted ${deletedCount} document${deletedCount === 1 ? '' : 's'}`,
        )
      }
      if (failedCount > 0) {
        toastRef.current.onError(
          `${failedCount} document${failedCount === 1 ? '' : 's'} could not be deleted`,
        )
      }
      return result
    } catch {
      toastRef.current.onError('Delete failed')
      return {
        success: false,
        deleted: [],
        deleted_documents: [],
        failed: Object.fromEntries(filenames.map(filename => [filename, 'Delete failed'])),
        message: 'Delete failed',
      }
    }
  }, [fetchDocuments])

  const convertToMarkdown = useCallback(async (
    converter: ConverterType = 'pymupdf',
    vlm?: VLMSettings,
    cloud?: CloudSettings,
  ) => {
    const docAtStart = selectedDocRef.current
    if (!docAtStart) return

    convertAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    convertAbortRef.current = abortCtrl

    setConverting(true)
    setConversionProgress({ current: 0, total: 0 })
    setConversionErrorMessage(null)
    try {
      const body: Record<string, unknown> = {
        filenames: [docAtStart],
        converter,
        force: true,
      }
      if (converter === 'vlm' && vlm) body.vlm = vlm
      if (converter === 'cloud' && cloud) body.cloud = cloud

      const res = await fetch(`${API}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortCtrl.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      if (!res.body) throw new Error('No response body')

      let mdContent: string | undefined
      let mdFilename: string | undefined
      let fileError: string | undefined
      let failedPages: number[] | undefined
      let resumedPages: number | undefined
      for await (const event of parseSse(res.body, () => setConversionErrorMessage(CONNECTION_LOST_MSG))) {
        if (selectedDocRef.current !== docAtStart || convertAbortRef.current !== abortCtrl) return
        if (event.type === 'progress') {
          setConversionProgress({ current: event.current as number, total: event.total as number })
        } else if (event.type === 'file_done') {
          if (!event.success) { fileError = String(event.error ?? 'Conversion failed'); break }
          mdContent = event.md_content as string
          mdFilename = event.md_filename as string | undefined
          failedPages = (event.failed_pages as number[] | null | undefined) ?? undefined
          resumedPages = (event.resumed_pages as number | null | undefined) ?? undefined
          break
        } else if (event.type === 'error') {
          throw new Error(String(event.message ?? 'Conversion error'))
        } else if (event.type === 'cancelled') {
          throw new DOMException('Conversion cancelled', 'AbortError')
        }
      }

      if (fileError) throw new Error(fileError)
      if (mdContent === undefined) throw new Error('Stream ended without a result')
      if (selectedDocRef.current !== docAtStart || convertAbortRef.current !== abortCtrl) return
      setDocumentData(prev => prev
        ? { ...prev, has_markdown: true, md_content: mdContent!, md_filename: mdFilename ?? prev.md_filename }
        : prev)
      // Tailor the success toast so the user immediately sees whether any
      // pages failed and whether the checkpoint shortened the run.  The
      // MarkdownViewer banner provides the per-page detail and retry action.
      if (failedPages && failedPages.length > 0) {
        const tail = resumedPages ? ` (resumed ${resumedPages} cached)` : ''
        toastRef.current.onError(`Converted with ${failedPages.length} failed page${failedPages.length !== 1 ? 's' : ''}${tail}`)
      } else if (resumedPages && resumedPages > 0) {
        toastRef.current.onSuccess(`Conversion complete ✓ (resumed ${resumedPages} cached pages)`)
      } else {
        toastRef.current.onSuccess('Conversion complete ✓')
      }
      // A new converter-suffixed file may have been written — refresh the
      // version list AND sync the dropdown selection so it points to the file
      // that's actually being displayed (instead of whichever variant was
      // selected before the conversion).
      if (mdFilename) {
        void syncSelectedMarkdownFromVersions(docAtStart, mdFilename, 'preferred')
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError(err instanceof Error ? err.message : 'Conversion failed')
    } finally {
      if (convertAbortRef.current === abortCtrl) {
        setConverting(false)
        setConversionProgress(null)
        setConversionErrorMessage(null)
      }
    }
  }, [syncSelectedMarkdownFromVersions])

  const cancelConversion = useCallback(() => {
    convertAbortRef.current?.abort()
    setConverting(false)
    setConversionProgress(null)
    setConversionErrorMessage(null)
  }, [])

  const convertMdToPdf = useCallback(async () => {
    if (!selectedDocRef.current) return

    const docAtStart = selectedDocRef.current
    const mdFilename = documentDataRef.current?.md_filename ?? docAtStart
    convertToPdfAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    convertToPdfAbortRef.current = abortCtrl

    setConvertingToPdf(true)
    try {
      const pdfFilename = await convertMarkdownToPdf(docAtStart, mdFilename, abortCtrl.signal)
      // Both state updates must be gated by the same "is the user still on
      // this doc?" check — otherwise a doc switch during conversion would
      // leave the previous-conversion's PDF metadata stamped onto the new
      // doc's ``documentData``, which would make the new doc claim it has
      // a PDF it doesn't actually own.
      if (selectedDocRef.current === docAtStart) {
        setSelectedDoc(pdfFilename)
        setDocumentData(prev => prev ? { ...prev, has_pdf: true, pdf_filename: pdfFilename } : prev)
      }
      await fetchDocuments()
      toastRef.current.onSuccess('Converted to PDF ✓')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError('MD to PDF conversion failed')
    } finally {
      if (convertToPdfAbortRef.current === abortCtrl) {
        setConvertingToPdf(false)
      }
    }
  }, [fetchDocuments])

  const cancelMdToPdfConversion = useCallback(() => {
    convertToPdfAbortRef.current?.abort()
    setConvertingToPdf(false)
  }, [])

  const saveMarkdown = useCallback(async (content: string) => {
    const docAtStart = selectedDocRef.current
    if (!docAtStart) return
    setSavingMd(true)
    try {
      const mdFilename =
        documentDataRef.current?.md_filename ??
        docAtStart.replace(/\.pdf$/i, '.md')
      await saveMarkdownFile(docAtStart, mdFilename, content)
      if (selectedDocRef.current !== docAtStart) return
      setAvailableChunks([])
      setSelectedChunks(null)
      setDocumentData(prev => prev ? { ...prev, md_content: content } : prev)
      void fetchVersions(docAtStart)
      toastRef.current.onSuccess('Markdown saved ✓')
    } catch (err) {
      toastRef.current.onError('Failed to save Markdown')
      throw err
    } finally {
      setSavingMd(false)
    }
  }, [fetchVersions])

  const deleteMarkdown = useCallback(async () => {
    const filename = selectedDocRef.current
    if (!filename) return
    const deletesWholeDocument =
      filename.toLowerCase().endsWith('.md') &&
      !documentDataRef.current?.has_pdf
    const mdFilename =
      documentDataRef.current?.md_filename ??
      filename.replace(/\.pdf$/i, '.md')
    try {
      await deleteMarkdownVariant(filename, mdFilename)
      if (selectedDocRef.current !== filename) return
      if (deletesWholeDocument) {
        setSelectedDoc(null)
        setDocumentData(null)
        setAvailableMarkdowns([])
        setAvailableChunks([])
        setSelectedMarkdown(null)
        setSelectedChunks(null)
        await fetchDocuments()
        toastRef.current.onSuccess('Markdown document deleted')
        return
      }
      // Other converter variants may still be on disk; re-fetch the version
      // list and either fall through to a sibling version or clear the
      // viewer if this was the last one.
      const remaining = await fetchVersions(filename)
      if (selectedDocRef.current !== filename) return
      if (remaining.length === 0) {
        setDocumentData(prev => prev ? { ...prev, has_markdown: false, md_content: '' } : prev)
        setSelectedMarkdown(null)
      } else {
        const next = remaining[0]
        const identifier = next.source === 'converted' && next.converter
          ? next.converter
          : next.filename
        await selectMarkdownVersion(identifier)
      }
      toastRef.current.onSuccess('Markdown removed — ready to reconvert')
    } catch {
      toastRef.current.onError('Failed to remove Markdown')
    }
  }, [fetchDocuments, fetchVersions, selectMarkdownVersion])

  const batchConvert = useCallback(async (
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
  ): Promise<void> => {
    const body: Record<string, unknown> = { filenames, converter, force: true }
    if (converter === 'vlm' && vlm) body.vlm = vlm
    if (converter === 'cloud' && cloud) body.cloud = cloud

    const res = await fetch(`${API}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text}`)
    }
    if (!res.body) throw new Error('No response body')

    let completed = false
    for await (const event of parseSse(res.body, onConnectionLost)) {
      if (event.type === 'progress') {
        onPageProgress?.(
          event.filename as string,
          event.current as number,
          event.total as number,
          event.file_index as number,
          event.file_total as number,
        )
      } else if (event.type === 'file_start') {
        onFileStart(
          event.filename as string,
          event.index as number,
          event.total as number,
        )
      } else if (event.type === 'file_done') {
        onFileResult(
          event.filename as string,
          event.success as boolean,
          (event.failed_pages as number[] | null | undefined) ?? undefined,
        )
      } else if (event.type === 'file_progress') {
        onBatchProgress(
          event.current as number,
          event.total as number,
          event.filename as string,
          event.percentage as number,
        )
        await new Promise<void>(r => setTimeout(r, 0))
      } else if (event.type === 'batch_done') {
        completed = true
        return
      } else if (event.type === 'cancelled') {
        return
      }
    }
    if (!completed) throw new Error('Conversion stream ended without completion')
  }, [])

  const refreshVersions = useCallback(async () => {
    const fn = selectedDocRef.current
    if (!fn) return
    try {
      await fetchVersions(fn)
    } catch {
      // Version lists are advisory state; callers that just completed a
      // successful write should not be turned into failures by a refresh miss.
    }
  }, [fetchVersions])

  return {
    documents, selectedDoc, documentData, loading, uploading, converting, convertingToPdf, savingMd,
    conversionProgress, conversionErrorMessage,
    selectDocument, refreshDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
    batchConvert,
    availableMarkdowns, availableChunks,
    selectedMarkdown, selectedChunks,
    selectMarkdownVersion,
    setSelectedChunks,
    refreshVersions,
  }
}
