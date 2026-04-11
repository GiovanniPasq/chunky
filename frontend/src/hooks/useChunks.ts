import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChunkSettings, Chunk, DocumentData } from '../types'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './useSettings'
import { consumeChunkSse } from '../utils/consumeChunkSse'
import { CONNECTION_LOST_MSG } from '../utils/parseSse'
import { API_BASE } from '../services/apiService'
import type { ToastCallbacks } from './useDocument'

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(k => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

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

  const toastRef = useRef<ToastCallbacks>(toast)
  toastRef.current = toast

  const chunkAbortRef = useRef<AbortController | null>(null)

  const chunkContent = useCallback(async (content: string, s: ChunkSettings) => {
    chunkAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    chunkAbortRef.current = abortCtrl

    setChunking(true)
    setChunks(null)
    try {
      const onConnectionLost = () => toastRef.current.onError(CONNECTION_LOST_MSG)
      const normalised = await consumeChunkSse(content, s, abortCtrl.signal, onConnectionLost)
      if (chunkAbortRef.current === abortCtrl) setChunks(normalised)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError('Chunking failed')
    } finally {
      if (chunkAbortRef.current === abortCtrl) {
        setChunking(false)
      }
    }
  }, [])

  const { splitterType, splitterLibrary, chunkSize, chunkOverlap, enableMarkdownSizing } = settings

  useEffect(() => {
    if (!chunkingEnabled || !documentData?.md_content) {
      chunkAbortRef.current?.abort()
      setChunks(null)
      setChunking(false)
      return
    }
    chunkContent(documentData.md_content, settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentData, splitterType, splitterLibrary, chunkSize, chunkOverlap, enableMarkdownSizing, chunkingEnabled, chunkContent])

  const cancelChunking = useCallback(() => {
    chunkAbortRef.current?.abort()
    setChunking(false)
  }, [])

  const applySettings = useCallback((newSettings: ChunkSettings) => {
    saveSettings(newSettings)
    setSettings(prev => ({
      ...newSettings,
      // Preserve object references for nested enrichment settings when their
      // values haven't changed — prevents MarkdownViewer / ChunkViewer from
      // re-rendering due to referential inequality inside React.memo.
      sectionEnrichment: shallowEqual(prev.sectionEnrichment, newSettings.sectionEnrichment)
        ? prev.sectionEnrichment
        : newSettings.sectionEnrichment,
      chunkEnrichment: shallowEqual(prev.chunkEnrichment, newSettings.chunkEnrichment)
        ? prev.chunkEnrichment
        : newSettings.chunkEnrichment,
    }))
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
          newChunks.push({
            ...toMerge[0],
            content: merged,
            end: toMerge[toMerge.length - 1].end,
            // The merged text is new — previous enrichment described only the
            // first chunk's content and is now semantically wrong.  Clear all
            // enrichment fields so the badge and downstream saves are accurate.
            cleaned_chunk: '',
            title: '',
            context: '',
            summary: '',
            keywords: [],
            questions: [],
          })
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
      const res = await fetch(`${API_BASE}/chunks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: selectedDoc,
          splitter_type: settings.splitterType,
          splitter_library: settings.splitterLibrary,
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
      toastRef.current.onSuccess(`Saved ${chunks.length} chunks ✓`)
    } catch {
      toastRef.current.onError('Failed to save chunks')
    } finally {
      setSaving(false)
    }
  }, [chunks, selectedDoc, settings.splitterType, settings.splitterLibrary])

  const enrichChunk = useCallback((index: number, updates: Partial<Chunk>) => {
    setChunks(prev => {
      if (!prev) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], ...updates }
      return updated
    })
  }, [])

  return {
    chunks, settings, saving, chunking,
    cancelChunking, applySettings, resetSettings,
    editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks, enrichChunk,
  }
}
