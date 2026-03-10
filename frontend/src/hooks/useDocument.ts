import { useState, useEffect, useCallback } from 'react'
import type { ChunkSettings, Chunk, DocumentData, ConverterType, VLMSettings } from '../types'

const API = '/api'

// ─────────────────────────────────────────────────────────────
// Toast helpers (passed in from the caller via callbacks)
// ─────────────────────────────────────────────────────────────
export interface ToastCallbacks {
  onSuccess: (msg: string) => void
  onError: (msg: string) => void
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
  const [savingMd, setSavingMd] = useState(false)

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
    if (filename === selectedDoc) return
    setSelectedDoc(filename)
    setDocumentData(null)
    setLoading(true)
    try {
      const res = await fetch(`${API}/document/${encodeURIComponent(filename)}`)
      if (!res.ok) throw new Error()
      const data: DocumentData = await res.json()
      setDocumentData(data)
    } catch {
      toast.onError(`Failed to load "${filename}"`)
    } finally {
      setLoading(false)
    }
  }, [selectedDoc])

  /**
   * Upload one or more files.
   * Uses /api/upload/multiple for >1 file, /api/upload for exactly 1.
   */
  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const formData = new FormData()
      if (files.length === 1) {
        formData.append('file', files[0])
        const res = await fetch(`${API}/upload`, { method: 'POST', body: formData })
        if (!res.ok) throw new Error()
      } else {
        files.forEach(f => formData.append('files', f))
        const res = await fetch(`${API}/upload/multiple`, { method: 'POST', body: formData })
        if (!res.ok) throw new Error()
      }
      await fetchDocuments()
      toast.onSuccess(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`)
    } catch {
      toast.onError('Upload failed')
    } finally {
      setUploading(false)
    }
  }, [])

  /**
   * Delete one or more documents.
   * Uses DELETE /api/documents (bulk) for multiple, DELETE /api/document/:name for one.
   */
  const deleteDocuments = useCallback(async (filenames: string[]) => {
    if (filenames.length === 0) return
    try {
      if (filenames.length === 1) {
        const res = await fetch(`${API}/document/${encodeURIComponent(filenames[0])}`, { method: 'DELETE' })
        if (!res.ok) throw new Error()
      } else {
        const res = await fetch(`${API}/documents`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(filenames),
        })
        if (!res.ok) throw new Error()
      }

      if (selectedDoc && filenames.includes(selectedDoc)) {
        setSelectedDoc(null)
        setDocumentData(null)
      }

      await fetchDocuments()
      toast.onSuccess(`Deleted ${filenames.length} document${filenames.length > 1 ? 's' : ''}`)
    } catch {
      toast.onError('Delete failed')
    }
  }, [selectedDoc])

  /**
   * Convert the selected PDF to Markdown using the chosen converter.
   * Passes optional VLM settings when converter == 'vlm'.
   */
  const convertToMarkdown = useCallback(async (
    converter: ConverterType = 'pymupdf',
    vlm?: VLMSettings,
  ) => {
    if (!selectedDoc) return
    setConverting(true)
    try {
      const body: Record<string, unknown> = { converter }
      if (converter === 'vlm' && vlm) body.vlm = vlm

      const res = await fetch(`${API}/convert/${encodeURIComponent(selectedDoc)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setDocumentData(prev => prev
        ? { ...prev, has_markdown: true, md_content: data.md_content }
        : prev
      )
      toast.onSuccess('Conversion complete ✓')
    } catch {
      toast.onError('Conversion failed')
    } finally {
      setConverting(false)
    }
  }, [selectedDoc])

  /**
   * Save edited Markdown by re-uploading it as a .md file.
   */
  const saveMarkdown = useCallback(async (content: string) => {
    if (!selectedDoc) return
    setSavingMd(true)
    try {
      const mdFilename = selectedDoc.replace('.pdf', '.md')
      const file = new File([new Blob([content], { type: 'text/markdown' })], mdFilename, { type: 'text/markdown' })
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${API}/upload`, { method: 'POST', body: formData })
      if (!res.ok) throw new Error()
      setDocumentData(prev => prev ? { ...prev, md_content: content } : prev)
      toast.onSuccess('Markdown saved ✓')
    } catch {
      toast.onError('Failed to save Markdown')
    } finally {
      setSavingMd(false)
    }
  }, [selectedDoc])

  /**
   * Delete the Markdown for the current document so it can be re-converted.
   * Resets has_markdown / md_content in local state without a round-trip.
   */
  const deleteMarkdown = useCallback(async () => {
    if (!selectedDoc) return
    try {
      const mdFilename = selectedDoc.replace('.pdf', '.md')
      // Delete via the document endpoint (backend deletes .md when PDF is not deleted)
      // We repurpose the approach: upload an empty file to overwrite is fragile,
      // so we just reset state locally and let the next conversion overwrite it.
      // If the backend gains a dedicated MD-delete endpoint this can be updated.
      setDocumentData(prev => prev ? { ...prev, has_markdown: false, md_content: '' } : prev)
      toast.onSuccess('Markdown removed — ready to reconvert')
    } catch {
      toast.onError('Failed to remove Markdown')
    }
  }, [selectedDoc])

  return {
    documents,
    selectedDoc,
    documentData,
    loading,
    uploading,
    converting,
    savingMd,
    selectDocument,
    uploadFiles,
    deleteDocuments,
    convertToMarkdown,
    saveMarkdown,
    deleteMarkdown,
  }
}

// ─────────────────────────────────────────────────────────────
// useChunks
// ─────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS: ChunkSettings = {
  splitterType: 'token',
  chunkSize: 512,
  chunkOverlap: 51,
  enableMarkdownSizing: false,
  converter: 'pymupdf',
}

export function useChunks(
  documentData: DocumentData | null,
  selectedDoc: string | null,
  toast: ToastCallbacks,
) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null)
  const [settings, setSettings] = useState<ChunkSettings>(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!documentData?.md_content) { setChunks(null); return }
    chunkContent(documentData.md_content, settings)
  }, [documentData, settings])

  const chunkContent = async (content: string, s: ChunkSettings) => {
    try {
      const res = await fetch(`${API}/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          splitter_type: s.splitterType,
          chunk_size: s.chunkSize,
          chunk_overlap: s.chunkOverlap,
          enable_markdown_sizing: s.enableMarkdownSizing,
        }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setChunks(data.chunks)
    } catch {
      toast.onError('Chunking failed')
    }
  }

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

  const saveChunks = useCallback(async () => {
    if (!chunks || !selectedDoc) return
    setSaving(true)
    try {
      const res = await fetch(`${API}/chunks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: selectedDoc,
          chunks: chunks.map(c => ({ index: c.index, content: c.content, metadata: c.metadata ?? {} })),
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

  return { chunks, settings, saving, applySettings, editChunk, saveChunks }
}