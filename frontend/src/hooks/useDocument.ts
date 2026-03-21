import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChunkSettings, Chunk, DocumentData, ConverterType, VLMSettings } from '../types'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './useSettings'

export type BulkProgressFn = (current: number, total: number, filename: string) => void
export type BulkResultFn = (filename: string, success: boolean) => void

const API = '/api'

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
// Shared SSE stream parser
// ─────────────────────────────────────────────────────────────

const SSE_SILENT_MS = 60_000
const CONNECTION_LOST_MSG =
  'Connection lost — the operation may have been interrupted. You can safely start a new conversion.'

/**
 * Async generator that yields parsed JSON events from an SSE ReadableStream.
 * Handles chunked delivery and multi-frame buffers correctly.
 * The underlying reader is always cancelled on return/throw.
 *
 * @param onSilent  Called when no bytes have been received for ``silentMs``
 *                  milliseconds.  Use this to show a "connection lost" warning.
 *                  The callback fires at most once per invocation.
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onSilent?: () => void,
  silentMs = SSE_SILENT_MS,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let silentTimer: ReturnType<typeof setTimeout> | null = null
  let silentFired = false

  const armTimer = () => {
    if (!onSilent || silentFired) return
    if (silentTimer !== null) clearTimeout(silentTimer)
    silentTimer = setTimeout(() => {
      silentFired = true
      onSilent()
    }, silentMs)
  }

  try {
    armTimer()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      armTimer() // reset on every chunk received (data frames and keepalives alike)
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue
        try {
          yield JSON.parse(part.slice(6)) as Record<string, unknown>
        } catch {
          // Skip malformed frames
        }
      }
    }
  } finally {
    if (silentTimer !== null) clearTimeout(silentTimer)
    reader.cancel()
  }
}


// ─────────────────────────────────────────────────────────────
// SSE stream consumer for chunking
// ─────────────────────────────────────────────────────────────

async function consumeChunkSse(
  content: string,
  s: ChunkSettings,
  signal?: AbortSignal,
): Promise<Chunk[]> {
  const res = await fetch(`${API}/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      content,
      splitter_type: s.splitterType,
      splitter_library: s.splitterLibrary,
      chunk_size: s.chunkSize,
      chunk_overlap: s.chunkOverlap,
      enable_markdown_sizing: s.enableMarkdownSizing,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  for await (const event of parseSse(res.body!)) {
    if (event.type === 'done') {
      const raw = (event.chunks as Chunk[]) ?? []
      return raw.map(c => ({
        index: c.index,
        content: c.content,
        cleaned_chunk: c.cleaned_chunk ?? '',
        title: c.title ?? '',
        context: c.context ?? '',
        summary: c.summary ?? '',
        keywords: c.keywords ?? [],
        questions: c.questions ?? [],
        metadata: c.metadata ?? {},
        start: c.start ?? 0,
        end: c.end ?? 0,
      }))
    } else if (event.type === 'error') {
      throw new Error(String(event.message ?? 'Chunking error'))
    } else if (event.type === 'cancelled') {
      throw new DOMException('Chunking cancelled', 'AbortError')
    }
  }
  throw new Error('Stream ended without a done event')
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

  // Track the currently selected filename in a ref so callbacks always see
  // the latest value without needing it in their dependency arrays.
  const selectedDocRef = useRef<string | null>(null)
  selectedDocRef.current = selectedDoc

  // AbortControllers for in-flight requests
  const fetchDocAbortRef = useRef<AbortController | null>(null)
  const convertAbortRef = useRef<AbortController | null>(null)
  const convertToPdfAbortRef = useRef<AbortController | null>(null)

  useEffect(() => { fetchDocuments() }, [])

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API}/documents`)
      const data: string[] = await res.json()
      setDocuments(data)
    } catch {
      toast.onError('Failed to fetch document list')
    }
  }

  const selectDocument = useCallback(async (filename: string) => {
    if (filename === selectedDocRef.current) return

    fetchDocAbortRef.current?.abort()
    fetchDocAbortRef.current = new AbortController()

    convertAbortRef.current?.abort()
    setConverting(false)

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
      toast.onError(`Failed to load "${filename}"`)
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
        const data = await res.json().catch(() => null)
        throw new Error(data?.detail ?? 'Upload failed')
      }
      await fetchDocuments()
      toast.onSuccess(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`)
    } catch (err) {
      toast.onError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }, [])

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
      toast.onSuccess(`Deleted ${filenames.length} document${filenames.length > 1 ? 's' : ''}`)
    } catch {
      toast.onError('Delete failed')
    }
  }, [])

  /**
   * Convert the currently selected document to Markdown.
   * Progress is streamed via SSE — no polling.
   */
  const convertToMarkdown = useCallback(async (
    converter: ConverterType = 'pymupdf',
    vlm?: VLMSettings,
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

      let mdContent: string | undefined
      for await (const event of parseSse(res.body!, () => setConversionErrorMessage(CONNECTION_LOST_MSG))) {
        if (event.type === 'progress') {
          setConversionProgress({ active: true, current: event.current as number, total: event.total as number })
        } else if (event.type === 'file_done') {
          if (!event.success) throw new Error(String(event.error ?? 'Conversion failed'))
          mdContent = event.md_content as string
        } else if (event.type === 'error') {
          throw new Error(String(event.message ?? 'Conversion error'))
        } else if (event.type === 'cancelled') {
          throw new DOMException('Conversion cancelled', 'AbortError')
        }
      }

      if (mdContent === undefined) throw new Error('Stream ended without a result')
      setDocumentData(prev => prev ? { ...prev, has_markdown: true, md_content: mdContent! } : prev)
      toast.onSuccess('Conversion complete ✓')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.onError(err instanceof Error ? err.message : 'Conversion failed')
    } finally {
      // Only reset state if this invocation is still the active one.
      // Guards against a new conversion starting before our async cleanup ran.
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

    convertToPdfAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    convertToPdfAbortRef.current = abortCtrl

    setConvertingToPdf(true)
    try {
      const res = await fetch(
        `${API}/md-to-pdf/${encodeURIComponent(selectedDocRef.current)}`,
        { method: 'POST', signal: abortCtrl.signal },
      )
      if (!res.ok) throw new Error()
      const data = await res.json()
      setSelectedDoc(data.pdf_filename)
      setDocumentData(prev => prev ? { ...prev, has_pdf: true, pdf_filename: data.pdf_filename } : prev)
      await fetchDocuments()
      toast.onSuccess('Converted to PDF ✓')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.onError('MD to PDF conversion failed')
    } finally {
      if (convertToPdfAbortRef.current === abortCtrl) {
        setConvertingToPdf(false)
      }
    }
  }, [])

  const cancelMdToPdfConversion = useCallback(() => {
    convertToPdfAbortRef.current?.abort()
    setConvertingToPdf(false)
  }, [])

  const saveMarkdown = useCallback(async (content: string) => {
    if (!selectedDocRef.current) return
    setSavingMd(true)
    try {
      const mdFilename = selectedDocRef.current.replace('.pdf', '.md')
      const file = new File([new Blob([content], { type: 'text/markdown' })], mdFilename, { type: 'text/markdown' })
      const formData = new FormData()
      formData.append('files', file)
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData })
      if (!res.ok) throw new Error()
      setDocumentData(prev => prev ? { ...prev, md_content: content } : prev)
      toast.onSuccess('Markdown saved ✓')
    } catch {
      toast.onError('Failed to save Markdown')
    } finally {
      setSavingMd(false)
    }
  }, [])

  const deleteMarkdown = useCallback(async () => {
    if (!selectedDocRef.current) return
    try {
      setDocumentData(prev => prev ? { ...prev, has_markdown: false, md_content: '' } : prev)
      toast.onSuccess('Markdown removed — ready to reconvert')
    } catch {
      toast.onError('Failed to remove Markdown')
    }
  }, [])

  /**
   * Convert multiple files concurrently via the unified /api/convert endpoint.
   * The backend runs up to MAX_CONCURRENT_CONVERSIONS in parallel with a semaphore.
   *
   * @param filenames        Files to convert.
   * @param converter        Converter engine.
   * @param vlm              Optional VLM overrides.
   * @param onFileStart      Called when each file begins processing.
   * @param onFileResult     Called when each file finishes (success or failure).
   * @param onBatchProgress  Called after each file completes with the running completion count.
   * @param signal           AbortSignal to cancel the entire batch mid-stream.
   * @param onConnectionLost Called when the SSE stream is silent for 60 s.
   * @param onPageProgress   Called on each VLM page event with per-page and per-file counts.
   */
  const batchConvert = useCallback(async (
    filenames: string[],
    converter: ConverterType,
    vlm: VLMSettings | undefined,
    onFileStart: (filename: string, index: number, total: number) => void,
    onFileResult: (filename: string, success: boolean) => void,
    onBatchProgress: (current: number, total: number, filename: string, percentage: number) => void,
    signal?: AbortSignal,
    onConnectionLost?: () => void,
    onPageProgress?: (filename: string, page: number, totalPages: number, fileIndex: number, fileTotal: number) => void,
  ): Promise<void> => {
    const body: Record<string, unknown> = { filenames, converter }
    if (converter === 'vlm' && vlm) body.vlm = vlm

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

    for await (const event of parseSse(res.body!, onConnectionLost)) {
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
        // Yield to the event loop so React flushes the state update before
        // processing the next event. Without this, React 18 automatic
        // batching would collect all setState calls in one synchronous pass
        // and render only the final value, making progress jump to 100%.
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
  ): Promise<void> => {
    const docRes = await fetch(`${API}/document/${encodeURIComponent(filename)}`)
    if (!docRes.ok) throw new Error('Failed to load document')
    const docData: DocumentData = await docRes.json()
    if (!docData.has_markdown) throw new Error('No markdown available')

    const chunks = await consumeChunkSse(docData.md_content, s)

    const saveRes = await fetch(`${API}/chunks/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, chunks }),
    })
    if (!saveRes.ok) throw new Error('Save failed')
  }, [])

  return {
    documents, selectedDoc, documentData, loading, uploading, converting, convertingToPdf, savingMd,
    conversionProgress, conversionErrorMessage,
    selectDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
    batchConvert, chunkAndSaveFile,
  }
}

// ─────────────────────────────────────────────────────────────
// useChunks
// ─────────────────────────────────────────────────────────────
export function useChunks(
  documentData: DocumentData | null,
  selectedDoc: string | null,
  chunkingEnabled: boolean,
  toast: ToastCallbacks,
) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null)
  const [settings, setSettings] = useState<ChunkSettings>(() => loadSettings())
  const [saving, setSaving] = useState(false)
  const [chunking, setChunking] = useState(false)

  const chunkAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!chunkingEnabled || !documentData?.md_content) {
      chunkAbortRef.current?.abort()
      setChunks(null)
      setChunking(false)
      return
    }
    chunkContent(documentData.md_content, settings)
  }, [documentData, settings, chunkingEnabled])

  const chunkContent = async (content: string, s: ChunkSettings) => {
    chunkAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    chunkAbortRef.current = abortCtrl

    setChunking(true)
    setChunks(null)
    try {
      const normalised = await consumeChunkSse(content, s, abortCtrl.signal)
      setChunks(normalised)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.onError('Chunking failed')
    } finally {
      if (chunkAbortRef.current === abortCtrl) {
        setChunking(false)
      }
    }
  }

  const cancelChunking = useCallback(() => {
    chunkAbortRef.current?.abort()
    setChunking(false)
  }, [])

  const applySettings = useCallback((newSettings: ChunkSettings) => {
    saveSettings(newSettings)
    setSettings(newSettings)
  }, [])

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS)
  }, [])

  const editChunk = useCallback((index: number, content: string) => {
    setChunks(prev => {
      if (!prev) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], content }
      return updated
    })
  }, [])

  const deleteChunk = useCallback((index: number) => {
    setChunks(prev => {
      if (!prev) return prev
      return prev
        .filter(c => c.index !== index)
        .map((c, i) => ({ ...c, index: i }))
    })
  }, [])

  const deleteChunks = useCallback((indices: Set<number>) => {
    setChunks(prev => {
      if (!prev) return prev
      return prev
        .filter(c => !indices.has(c.index))
        .map((c, i) => ({ ...c, index: i }))
    })
  }, [])

  const mergeChunks = useCallback((indices: number[]) => {
    if (indices.length < 2) return
    setChunks(prev => {
      if (!prev) return prev
      const sorted = [...indices].sort((a, b) => a - b)
      const toMerge = sorted.map(i => prev[i]).filter(Boolean)
      if (toMerge.length < 2) return prev

      let merged = toMerge[0].content
      for (let i = 1; i < toMerge.length; i++) {
        const b = toMerge[i].content
        const maxLen = Math.min(merged.length, b.length, 300)
        let overlapLen = 0
        for (let len = maxLen; len > 0; len--) {
          if (merged.slice(-len) === b.slice(0, len)) {
            overlapLen = len
            break
          }
        }
        merged = overlapLen > 0 ? merged + b.slice(overlapLen) : merged + '\n\n' + b
      }

      const sortedSet = new Set(sorted)
      const newChunks: Chunk[] = []
      for (let i = 0; i < prev.length; i++) {
        if (i === sorted[0]) {
          newChunks.push({ ...toMerge[0], content: merged, end: toMerge[toMerge.length - 1].end })
        } else if (!sortedSet.has(i)) {
          newChunks.push(prev[i])
        }
      }
      return newChunks.map((c, i) => ({ ...c, index: i }))
    })
  }, [])

  const saveChunks = useCallback(async () => {
    if (!chunks || !selectedDoc) return
    setSaving(true)
    try {
      const res = await fetch(`${API}/chunks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: selectedDoc,
          chunks: chunks.map(c => ({
            index: c.index,
            content: c.content,
            cleaned_chunk: c.cleaned_chunk,
            title: c.title,
            context: c.context,
            summary: c.summary,
            keywords: c.keywords,
            questions: c.questions,
            metadata: c.metadata ?? {},
            start: c.start,
            end: c.end,
          })),
        }),
      })
      if (!res.ok) throw new Error()
      toast.onSuccess(`Saved ${chunks.length} chunks ✓`)
    } catch {
      toast.onError('Failed to save chunks')
    } finally {
      setSaving(false)
    }
  }, [chunks, selectedDoc])

  const enrichChunk = useCallback((index: number, updates: Partial<Chunk>) => {
    setChunks(prev => {
      if (!prev) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], ...updates }
      return updated
    })
  }, [])

  return { chunks, settings, saving, chunking, cancelChunking, applySettings, resetSettings, editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks, enrichChunk }
}
