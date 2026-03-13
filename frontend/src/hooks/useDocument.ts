import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChunkSettings, Chunk, DocumentData, ConverterType, VLMSettings } from '../types'

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

  // Track the currently selected filename in a ref so callbacks always see
  // the latest value without needing it in their dependency arrays.
  const selectedDocRef = useRef<string | null>(null)
  selectedDocRef.current = selectedDoc

  // AbortControllers for in-flight requests
  const fetchDocAbortRef = useRef<AbortController | null>(null)
  const convertAbortRef = useRef<AbortController | null>(null)
  const convertToPdfAbortRef = useRef<AbortController | null>(null)
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => { fetchDocuments() }, [])

  // Poll conversion progress while converting
  useEffect(() => {
    if (converting && selectedDocRef.current) {
      const filename = selectedDocRef.current
      progressPollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${API}/convert-progress/${encodeURIComponent(filename)}`)
          if (res.ok) setConversionProgress(await res.json())
        } catch { /* ignore transient errors */ }
      }, 500)
    } else {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current)
        progressPollRef.current = null
      }
      setConversionProgress(null)
    }
    return () => {
      if (progressPollRef.current) {
        clearInterval(progressPollRef.current)
        progressPollRef.current = null
      }
    }
  }, [converting])

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API}/documents`)
      const data: string[] = await res.json()
      setDocuments(data)
    } catch {
      toast.onError('Failed to fetch document list')
    }
  }

  // Use a ref-based guard instead of putting selectedDoc in deps,
  // which caused stale closures and missed clicks when switching rapidly.
  const selectDocument = useCallback(async (filename: string) => {
    if (filename === selectedDocRef.current) return

    // Abort any in-flight document fetch
    fetchDocAbortRef.current?.abort()
    fetchDocAbortRef.current = new AbortController()

    // Also abort any running conversion — it belongs to the old document
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
  }, []) // no deps — reads selectedDoc via ref

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const formData = new FormData()
      files.forEach(f => formData.append('files', f))
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData })
      if (!res.ok) throw new Error()
      await fetchDocuments()
      toast.onSuccess(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`)
    } catch {
      toast.onError('Upload failed')
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

  const convertToMarkdown = useCallback(async (
    converter: ConverterType = 'pymupdf',
    vlm?: VLMSettings,
  ) => {
    if (!selectedDocRef.current) return

    // Abort any previous conversion
    convertAbortRef.current?.abort()
    convertAbortRef.current = new AbortController()

    setConverting(true)
    try {
      const body: Record<string, unknown> = { converter }
      if (converter === 'vlm' && vlm) body.vlm = vlm

      const res = await fetch(
        `${API}/convert/${encodeURIComponent(selectedDocRef.current)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: convertAbortRef.current.signal,
        },
      )
      if (!res.ok) throw new Error()
      const data = await res.json()
      setDocumentData(prev => prev
        ? { ...prev, has_markdown: true, md_content: data.md_content }
        : prev
      )
      toast.onSuccess('Conversion complete ✓')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.onError('Conversion failed')
    } finally {
      setConverting(false)
    }
  }, [])

  /** Cancel an in-progress conversion. */
  const cancelConversion = useCallback(() => {
    convertAbortRef.current?.abort()
    setConverting(false)
  }, [])

  const convertMdToPdf = useCallback(async () => {
    if (!selectedDocRef.current) return

    convertToPdfAbortRef.current?.abort()
    convertToPdfAbortRef.current = new AbortController()

    setConvertingToPdf(true)
    try {
      const res = await fetch(
        `${API}/md-to-pdf/${encodeURIComponent(selectedDocRef.current)}`,
        { method: 'POST', signal: convertToPdfAbortRef.current.signal },
      )
      if (!res.ok) throw new Error()
      const data = await res.json()
      // Switch to the newly created PDF document
      setSelectedDoc(data.pdf_filename)
      setDocumentData(prev => prev ? { ...prev, has_pdf: true, pdf_filename: data.pdf_filename } : prev)
      await fetchDocuments()
      toast.onSuccess('Converted to PDF ✓')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.onError('MD to PDF conversion failed')
    } finally {
      setConvertingToPdf(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  return {
    documents, selectedDoc, documentData, loading, uploading, converting, convertingToPdf, savingMd,
    conversionProgress,
    selectDocument, uploadFiles, deleteDocuments,
    convertToMarkdown, cancelConversion,
    convertMdToPdf, cancelMdToPdfConversion,
    saveMarkdown, deleteMarkdown,
  }
}

// ─────────────────────────────────────────────────────────────
// useChunks
// ─────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS: ChunkSettings = {
  splitterType: 'token',
  splitterLibrary: 'langchain',
  chunkSize: 512,
  chunkOverlap: 51,
  enableMarkdownSizing: false,
  converter: 'pymupdf',
}

export function useChunks(
  documentData: DocumentData | null,
  selectedDoc: string | null,
  chunkingEnabled: boolean,
  toast: ToastCallbacks,
) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null)
  const [settings, setSettings] = useState<ChunkSettings>(DEFAULT_SETTINGS)
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
    chunkAbortRef.current = new AbortController()

    setChunking(true)
    setChunks(null)
    try {
      const res = await fetch(`${API}/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: chunkAbortRef.current.signal,
        body: JSON.stringify({
          content,
          splitter_type: s.splitterType,
          splitter_library: s.splitterLibrary,
          chunk_size: s.chunkSize,
          chunk_overlap: s.chunkOverlap,
          enable_markdown_sizing: s.enableMarkdownSizing,
        }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      const normalised: Chunk[] = (data.chunks as Chunk[]).map(c => ({
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
      setChunks(normalised)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toast.onError('Chunking failed')
    } finally {
      setChunking(false)
    }
  }

  /** Cancel an in-progress chunking request. */
  const cancelChunking = useCallback(() => {
    chunkAbortRef.current?.abort()
    setChunking(false)
  }, [])

  const applySettings = useCallback((newSettings: ChunkSettings) => {
    setSettings(newSettings)
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

  /** Merge an ordered list of chunk indices into a single chunk, removing overlap. */
  const mergeChunks = useCallback((indices: number[]) => {
    if (indices.length < 2) return
    setChunks(prev => {
      if (!prev) return prev
      const sorted = [...indices].sort((a, b) => a - b)
      const toMerge = sorted.map(i => prev[i]).filter(Boolean)
      if (toMerge.length < 2) return prev

      // Concatenate, removing the overlap suffix/prefix between consecutive chunks.
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

  return { chunks, settings, saving, chunking, cancelChunking, applySettings, editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks }
}
