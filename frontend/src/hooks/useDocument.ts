import { useState, useEffect, useCallback } from 'react'
import type { ChunkSettings, Chunk, DocumentData } from '../types'

const API = '/api'

// ─────────────────────────────────────────────────────────────
// useDocument
// ─────────────────────────────────────────────────────────────
export function useDocument() {
  const [documents, setDocuments] = useState<string[]>([])
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [documentData, setDocumentData] = useState<DocumentData | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [converting, setConverting] = useState(false)
  const [savingMd, setSavingMd] = useState(false)

  // Load document list on mount
  useEffect(() => { fetchDocuments() }, [])

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API}/documents`)
      const data: string[] = await res.json()
      setDocuments(data)
    } catch (e) {
      console.error('Failed to fetch documents', e)
    }
  }

  const selectDocument = useCallback(async (filename: string) => {
    if (filename === selectedDoc) return
    setSelectedDoc(filename)
    setDocumentData(null)
    setLoading(true)
    try {
      const res = await fetch(`${API}/document/${encodeURIComponent(filename)}`)
      const data: DocumentData = await res.json()
      setDocumentData(data)
    } catch (e) {
      console.error('Failed to load document', e)
    } finally {
      setLoading(false)
    }
  }, [selectedDoc])

  /**
   * Upload one or more files.
   * Uses /api/upload/multiple for >1 file, /api/upload for exactly 1
   * to stay backwards compatible with the single-file endpoint.
   */
  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const formData = new FormData()

      if (files.length === 1) {
        formData.append('file', files[0])
        await fetch(`${API}/upload`, { method: 'POST', body: formData })
      } else {
        files.forEach(f => formData.append('files', f))
        await fetch(`${API}/upload/multiple`, { method: 'POST', body: formData })
      }

      await fetchDocuments()
    } catch (e) {
      console.error('Upload failed', e)
    } finally {
      setUploading(false)
    }
  }, [])

  /**
   * Delete one or more documents.
   * Uses DELETE /api/documents (bulk body) for multiple files,
   * DELETE /api/document/:filename for a single file.
   */
  const deleteDocuments = useCallback(async (filenames: string[]) => {
    if (filenames.length === 0) return
    try {
      if (filenames.length === 1) {
        await fetch(`${API}/document/${encodeURIComponent(filenames[0])}`, {
          method: 'DELETE',
        })
      } else {
        await fetch(`${API}/documents`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(filenames),
        })
      }

      // Deselect if the current doc was deleted
      if (selectedDoc && filenames.includes(selectedDoc)) {
        setSelectedDoc(null)
        setDocumentData(null)
      }

      await fetchDocuments()
    } catch (e) {
      console.error('Delete failed', e)
    }
  }, [selectedDoc])

  const convertToMarkdown = useCallback(async () => {
    if (!selectedDoc) return
    setConverting(true)
    try {
      const res = await fetch(`${API}/convert/${encodeURIComponent(selectedDoc)}`, {
        method: 'POST',
      })
      const data = await res.json()
      setDocumentData(prev => prev
        ? { ...prev, has_markdown: true, md_content: data.md_content }
        : prev
      )
    } catch (e) {
      console.error('Conversion failed', e)
    } finally {
      setConverting(false)
    }
  }, [selectedDoc])

  const saveMarkdown = useCallback(async (content: string) => {
    if (!selectedDoc) return
    setSavingMd(true)
    try {
      // Persist via upload: create a Blob as a .md file and re-upload
      const mdFilename = selectedDoc.replace('.pdf', '.md')
      const blob = new Blob([content], { type: 'text/markdown' })
      const file = new File([blob], mdFilename, { type: 'text/markdown' })
      const formData = new FormData()
      formData.append('file', file)
      await fetch(`${API}/upload`, { method: 'POST', body: formData })
      setDocumentData(prev => prev ? { ...prev, md_content: content } : prev)
    } catch (e) {
      console.error('Save markdown failed', e)
    } finally {
      setSavingMd(false)
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
}

export function useChunks(
  documentData: DocumentData | null,
  selectedDoc: string | null,
) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null)
  const [settings, setSettings] = useState<ChunkSettings>(DEFAULT_SETTINGS)
  const [saving, setSaving] = useState(false)

  // Re-chunk whenever document or settings change
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
      const data = await res.json()
      setChunks(data.chunks)
    } catch (e) {
      console.error('Chunking failed', e)
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
      await fetch(`${API}/chunks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: selectedDoc,
          chunks: chunks.map(c => ({ index: c.index, content: c.content, metadata: c.metadata ?? {} })),
        }),
      })
    } catch (e) {
      console.error('Save chunks failed', e)
    } finally {
      setSaving(false)
    }
  }, [chunks, selectedDoc])

  return { chunks, settings, saving, applySettings, editChunk, saveChunks }
}