import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChunkSettings, DocumentData, ConverterType, VLMSettings, CloudSettings } from '../types'
import { parseSse, CONNECTION_LOST_MSG } from '../utils/parseSse'
import { consumeChunkSse } from '../utils/consumeChunkSse'
import { API_BASE } from '../services/apiService'

export type BulkProgressFn = (current: number, total: number, filename: string) => void
export type BulkResultFn = (filename: string, success: boolean) => void

const API = API_BASE

export interface ToastCallbacks {
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
}

export interface ConversionProgress {
  active: boolean
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
  const convertAbortRef = useRef<AbortController | null>(null)
  const convertToPdfAbortRef = useRef<AbortController | null>(null)

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch(`${API}/documents`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: string[] = await res.json()
      setDocuments(data)
    } catch {
      toastRef.current.onError('Failed to fetch document list')
    }
  }, [])

  useEffect(() => { fetchDocuments() }, [fetchDocuments])

  /** Re-fetch document data for the currently selected document (e.g. after batch conversion). */
  const refreshDocument = useCallback(async () => {
    const filename = selectedDocRef.current
    if (!filename) return

    fetchDocAbortRef.current?.abort()
    fetchDocAbortRef.current = new AbortController()

    setLoading(true)
    try {
      const res = await fetch(
        `${API}/document/${encodeURIComponent(filename)}`,
        { signal: fetchDocAbortRef.current.signal },
      )
      if (!res.ok) throw new Error()
      const data: DocumentData = await res.json()
      setDocumentData(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
    } finally {
      setLoading(false)
    }
  }, [])

  const selectDocument = useCallback(async (filename: string) => {
    if (filename === selectedDocRef.current) return

    fetchDocAbortRef.current?.abort()
    fetchDocAbortRef.current = new AbortController()

    convertAbortRef.current?.abort()
    setConverting(false)
    setConversionErrorMessage(null)

    setSelectedDoc(filename)
    setDocumentData(null)
    setLoading(true)
    try {
      const res = await fetch(
        `${API}/document/${encodeURIComponent(filename)}`,
        { signal: fetchDocAbortRef.current.signal },
      )
      if (!res.ok) throw new Error()
      const data: DocumentData = await res.json()
      setDocumentData(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError(`Failed to load "${filename}"`)
    } finally {
      setLoading(false)
    }
  }, [])

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const formData = new FormData()
      files.forEach(f => formData.append('files', f))
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail = 'Upload failed'
        try { detail = (JSON.parse(text) as { detail?: string })?.detail ?? (text || detail) } catch { detail = text || detail }
        throw new Error(detail)
      }
      await fetchDocuments()
      toastRef.current.onSuccess(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`)
    } catch (err) {
      toastRef.current.onError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [fetchDocuments])

  const deleteDocuments = useCallback(async (filenames: string[]) => {
    if (filenames.length === 0) return
    try {
      const res = await fetch(`${API}/documents`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filenames),
      })
      if (!res.ok) throw new Error()
      if (selectedDocRef.current && filenames.includes(selectedDocRef.current)) {
        setSelectedDoc(null)
        setDocumentData(null)
      }
      await fetchDocuments()
      toastRef.current.onSuccess(`Deleted ${filenames.length} document${filenames.length > 1 ? 's' : ''}`)
    } catch {
      toastRef.current.onError('Delete failed')
    }
  }, [fetchDocuments])

  const convertToMarkdown = useCallback(async (
    converter: ConverterType = 'pymupdf',
    vlm?: VLMSettings,
    cloud?: CloudSettings,
  ) => {
    if (!selectedDocRef.current) return

    convertAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    convertAbortRef.current = abortCtrl

    setConverting(true)
    setConversionProgress({ active: true, current: 0, total: 0 })
    setConversionErrorMessage(null)
    try {
      const body: Record<string, unknown> = {
        filenames: [selectedDocRef.current],
        converter,
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
      let fileError: string | undefined
      for await (const event of parseSse(res.body, () => setConversionErrorMessage(CONNECTION_LOST_MSG))) {
        if (event.type === 'progress') {
          setConversionProgress({ active: true, current: event.current as number, total: event.total as number })
        } else if (event.type === 'file_done') {
          if (!event.success) { fileError = String(event.error ?? 'Conversion failed'); break }
          mdContent = event.md_content as string
        } else if (event.type === 'error') {
          throw new Error(String(event.message ?? 'Conversion error'))
        } else if (event.type === 'cancelled') {
          throw new DOMException('Conversion cancelled', 'AbortError')
        }
      }

      if (fileError) throw new Error(fileError)
      if (mdContent === undefined) throw new Error('Stream ended without a result')
      setDocumentData(prev => prev ? { ...prev, has_markdown: true, md_content: mdContent! } : prev)
      toastRef.current.onSuccess('Conversion complete ✓')
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
  }, [])

  const cancelConversion = useCallback(() => {
    convertAbortRef.current?.abort()
    setConverting(false)
    setConversionProgress(null)
    setConversionErrorMessage(null)
  }, [])

  const convertMdToPdf = useCallback(async () => {
    if (!selectedDocRef.current) return

    const docAtStart = selectedDocRef.current
    convertToPdfAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    convertToPdfAbortRef.current = abortCtrl

    setConvertingToPdf(true)
    try {
      const res = await fetch(
        `${API}/md-to-pdf/${encodeURIComponent(docAtStart)}`,
        { method: 'POST', signal: abortCtrl.signal },
      )
      if (!res.ok) throw new Error()
      const data = await res.json()
      if (typeof data.pdf_filename !== 'string') throw new Error('Invalid response: missing pdf_filename')
      if (selectedDocRef.current === docAtStart) setSelectedDoc(data.pdf_filename)
      setDocumentData(prev => prev ? { ...prev, has_pdf: true, pdf_filename: data.pdf_filename } : prev)
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
    if (!selectedDocRef.current) return
    setSavingMd(true)
    try {
      const mdFilename =
        documentDataRef.current?.md_filename ??
        selectedDocRef.current.replace(/\.pdf$/i, '.md')
      const file = new File([new Blob([content], { type: 'text/markdown' })], mdFilename, { type: 'text/markdown' })
      const formData = new FormData()
      formData.append('files', file)
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData })
      if (!res.ok) throw new Error()
      setDocumentData(prev => prev ? { ...prev, md_content: content } : prev)
      toastRef.current.onSuccess('Markdown saved ✓')
    } catch {
      toastRef.current.onError('Failed to save Markdown')
    } finally {
      setSavingMd(false)
    }
  }, [])

  const deleteMarkdown = useCallback(async () => {
    if (!selectedDocRef.current) return
    const mdFilename =
      documentDataRef.current?.md_filename ??
      selectedDocRef.current.replace(/\.pdf$/i, '.md')
    try {
      const res = await fetch(`${API}/documents`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([mdFilename]),
      })
      if (!res.ok) throw new Error()
      setDocumentData(prev => prev ? { ...prev, has_markdown: false, md_content: '' } : prev)
      toastRef.current.onSuccess('Markdown removed — ready to reconvert')
    } catch {
      toastRef.current.onError('Failed to remove Markdown')
    }
  }, [])

  const batchConvert = useCallback(async (
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
  ): Promise<void> => {
    const body: Record<string, unknown> = { filenames, converter }
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
        onFileResult(event.filename as string, event.success as boolean)
      } else if (event.type === 'file_progress') {
        onBatchProgress(
          event.current as number,
          event.total as number,
          event.filename as string,
          event.percentage as number,
        )
        await new Promise<void>(r => setTimeout(r, 0))
      } else if (event.type === 'batch_done' || event.type === 'cancelled') {
        return
      }
    }
  }, [])

  /** Chunk and save a specific file without changing the selected document. */
  const chunkAndSaveFile = useCallback(async (
    filename: string,
    s: ChunkSettings,
    signal?: AbortSignal,
  ): Promise<void> => {
    const docRes = await fetch(`${API}/document/${encodeURIComponent(filename)}`, { signal })
    if (!docRes.ok) throw new Error('Failed to load document')
    const docData: DocumentData = await docRes.json()
    if (!docData.has_markdown) throw new Error('No markdown available')

    const chunks = await consumeChunkSse(docData.md_content, s, signal)

    const saveRes = await fetch(`${API}/chunks/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        filename,
        splitter_type: s.splitterType,
        splitter_library: s.splitterLibrary,
        chunks,
      }),
    })
    if (!saveRes.ok) throw new Error('Save failed')
  }, [])

  return {
    documents, selectedDoc, documentData, loading, uploading, converting, convertingToPdf, savingMd,
    conversionProgress, conversionErrorMessage,
    selectDocument, refreshDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
    batchConvert, chunkAndSaveFile,
  }
}
