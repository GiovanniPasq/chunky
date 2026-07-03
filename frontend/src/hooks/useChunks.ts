import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ChunkSettings, Chunk, ChunksVersion, DocumentData } from '../types'
import { loadSettings, saveSettings } from './useSettings'
import { chunkSse, loadSavedChunksFile, saveChunks as saveChunksApi } from '../services/chunksApi'
import { CONNECTION_LOST_MSG } from '../utils/parseSse'
import { buildChunkConfigSignature, buildContentRevision, findMatchingSavedChunks } from '../utils/chunkUtils'
import { CHUNK_OVERLAP_SCAN_TAIL } from '../config'
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
  // Inputs needed to auto-link the chunk panel to a saved version that
  // already matches the current configuration — handed in from App so
  // useChunks doesn't have to know about useDocument's shape.
  availableChunks: ChunksVersion[],
  currentMdSource: string | null,
  setSelectedChunksFilename: (filename: string | null) => void,
) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null)
  const [settings, setSettings] = useState<ChunkSettings>(() => loadSettings())
  const [saving, setSaving] = useState(false)
  const [chunking, setChunking] = useState(false)
  // Tracks whether the in-memory chunk list has been mutated (edited, deleted,
  // merged, enriched) since the last save / fresh load.  Used by the App-level
  // confirmation flow to warn before discarding unsaved work.
  const [chunksDirty, setChunksDirty] = useState(false)
  const [chunkRevision, setChunkRevision] = useState(0)

  const toastRef = useRef<ToastCallbacks>(toast)
  toastRef.current = toast
  const selectedDocRef = useRef<string | null>(selectedDoc)
  selectedDocRef.current = selectedDoc

  const chunkAbortRef = useRef<AbortController | null>(null)
  // Tracks the in-flight loadSavedChunks fetch separately from the live
  // chunkContent stream so a fast second selection cleanly cancels a slower
  // first one (otherwise the late response can clobber the new selection
  // and the picker appears stuck).
  const loadAbortRef = useRef<AbortController | null>(null)
  // Signature of the (doc, MD, splitter) configuration that produced the
  // chunks currently in state.  Used by the chunking effect to skip work
  // when the user merely toggles the chunks panel back into view — without
  // it, hiding+showing the panel would clobber any saved-version the user
  // had loaded with a fresh re-chunk.
  const chunkedSigRef = useRef<string>('')
  const chunkSourceHashRef = useRef<string | null>(null)
  const replaceChunkSet = useCallback((next: Chunk[] | null, sourceHash: string | null) => {
    chunkSourceHashRef.current = sourceHash
    setChunkRevision(revision => revision + 1)
    setChunks(next)
  }, [])

  useEffect(() => () => {
    chunkAbortRef.current?.abort()
    loadAbortRef.current?.abort()
  }, [])

  const chunkContent = useCallback(async (
    filename: string,
    s: ChunkSettings,
    md: string | null,
  ) => {
    chunkAbortRef.current?.abort()
    loadAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    chunkAbortRef.current = abortCtrl

    setChunking(true)
    replaceChunkSet(null, null)
    try {
      const onConnectionLost = () => toastRef.current.onError(CONNECTION_LOST_MSG)
      const result = await chunkSse(
        [filename], s, abortCtrl.signal, onConnectionLost,
        undefined, undefined, md,
      )
      if (chunkAbortRef.current === abortCtrl && selectedDocRef.current === filename) {
        replaceChunkSet(result.chunks, result.sourceHash)
        setChunksDirty(false)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError('Chunking failed')
    } finally {
      if (chunkAbortRef.current === abortCtrl) {
        setChunking(false)
      }
    }
  }, [replaceChunkSet])

  const { chunkerType, chunkerLibrary, chunkSize, chunkOverlap, enableMarkdownSizing } = settings
  const hasMarkdown = documentData?.has_markdown ?? false
  // Derive the active Markdown filename from documentData rather than carrying
  // a separate prop.  documentData.md_filename is updated atomically whenever
  // the user converts, switches a variant from the dropdown, or the backend
  // refreshes after batch-convert — so keying chunking off this value avoids
  // any drift between "what the viewer is showing" and "what we're chunking".
  const mdFilename = documentData?.md_filename ?? null
  const mdContent = documentData?.md_content ?? ''
  const mdContentRevision = useMemo(() => buildContentRevision(mdContent), [mdContent])

  /** Internal-only loader used by the chunking effect when a matching saved
   *  version is detected.  Identical to the public loadSavedChunks below
   *  except that it leaves chunkedSigRef alone — the effect has already set
   *  the signature for this configuration. */
  const autoLoadSavedChunks = useCallback(async (
    chunksFilename: string,
    fallbackSettings: ChunkSettings,
    fallbackMdFilename: string | null,
  ) => {
    const filename = selectedDoc
    if (!filename) return
    chunkAbortRef.current?.abort()
    loadAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    loadAbortRef.current = abortCtrl
    setChunking(false)
    try {
      const loaded = await loadSavedChunksFile(filename, chunksFilename, abortCtrl.signal)
      if (loadAbortRef.current !== abortCtrl || selectedDocRef.current !== filename) return
      replaceChunkSet(loaded.chunks, loaded.sourceHash)
      setChunksDirty(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setSelectedChunksFilename(null)
      toastRef.current.onError('Saved chunks could not be loaded — regenerating')
      await chunkContent(filename, fallbackSettings, fallbackMdFilename)
    }
  }, [selectedDoc, replaceChunkSet, setSelectedChunksFilename, chunkContent])

  useEffect(() => {
    if (!selectedDoc || !hasMarkdown) {
      chunkAbortRef.current?.abort()
      loadAbortRef.current?.abort()
      replaceChunkSet(null, null)
      setChunking(false)
      chunkedSigRef.current = ''
      return
    }
    // When the chunks panel is hidden we keep whatever's already in state
    // (fresh OR a loaded saved version) so re-opening the panel doesn't
    // discard the user's selection — only abort any pending request.
    if (!chunkingEnabled) {
      chunkAbortRef.current?.abort()
      loadAbortRef.current?.abort()
      return
    }
    // Include availableChunks.length and currentMdSource in the signature
    // so the effect re-evaluates when the version list arrives *after* the
    // document fetch.  Without this, doc-switch loads finish before the
    // chunks-version listing does, sig stays the same, and the auto-link
    // never fires.
    const sig = buildChunkConfigSignature(
      selectedDoc, mdFilename, currentMdSource, settings, availableChunks.length, mdContentRevision,
    )
    if (sig === chunkedSigRef.current) return
    chunkedSigRef.current = sig

    // If a saved chunks file matches the current configuration (same MD
    // source + library + algorithm + size + overlap), surface it instead
    // of re-chunking from scratch.  Saves compute and lets the dropdown
    // auto-select the matching entry.
    const matching = findMatchingSavedChunks(availableChunks, currentMdSource, settings)
    if (matching) {
      setSelectedChunksFilename(matching.filename)
      autoLoadSavedChunks(matching.filename, settings, mdFilename)
    } else {
      setSelectedChunksFilename(null)
      chunkContent(selectedDoc, settings, mdFilename)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoc, mdFilename, mdContentRevision, hasMarkdown, chunkerType, chunkerLibrary, chunkSize, chunkOverlap, enableMarkdownSizing, chunkingEnabled, chunkContent, availableChunks, currentMdSource])

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

  const editChunk = useCallback((index: number, content: string) => {
    setChunks(prev => {
      if (!prev) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], content }
      return updated
    })
    setChunksDirty(true)
  }, [])

  const deleteChunk = useCallback((index: number) => {
    setChunks(prev => {
      if (!prev) return prev
      return prev
        .filter(c => c.index !== index)
        .map((c, i) => ({ ...c, index: i }))
    })
    setChunksDirty(true)
  }, [])

  const deleteChunks = useCallback((indices: Set<number>) => {
    setChunks(prev => {
      if (!prev) return prev
      return prev
        .filter(c => !indices.has(c.index))
        .map((c, i) => ({ ...c, index: i }))
    })
    setChunksDirty(true)
  }, [])

  const mergeChunks = useCallback((indices: number[]) => {
    if (indices.length < 2) return
    setChunksDirty(true)
    setChunks(prev => {
      if (!prev) return prev
      const sorted = [...indices].sort((a, b) => a - b)
      const toMerge = sorted.map(i => prev[i]).filter(Boolean)
      if (toMerge.length < 2) return prev

      const parts: string[] = [toMerge[0].content]
      // tail: last N chars of accumulated text — enough for overlap detection,
      // avoids joining the full parts array on every iteration (O(N²) → O(N)).
      let tail = toMerge[0].content.slice(-CHUNK_OVERLAP_SCAN_TAIL)
      for (let i = 1; i < toMerge.length; i++) {
        const b = toMerge[i].content
        const maxLen = Math.min(tail.length, b.length, CHUNK_OVERLAP_SCAN_TAIL)
        let overlapLen = 0
        for (let len = maxLen; len > 0; len--) {
          if (tail.slice(-len) === b.slice(0, len)) {
            overlapLen = len
            break
          }
        }
        const addition = overlapLen > 0 ? b.slice(overlapLen) : '\n\n' + b
        parts.push(addition)
        tail = (tail + addition).slice(-CHUNK_OVERLAP_SCAN_TAIL)
      }
      const merged = parts.join('')

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

  const saveChunks = useCallback(async (): Promise<string | null> => {
    if (!chunks || !selectedDoc) return null
    setSaving(true)
    try {
      const savedFilename = await saveChunksApi({
        filename: selectedDoc,
        mdFilename,
        sourceHash: chunkSourceHashRef.current,
        settings,
        chunks,
      })
      setChunksDirty(false)
      toastRef.current.onSuccess(`Saved ${chunks.length} chunks ✓`)
      return savedFilename
    } catch {
      toastRef.current.onError('Failed to save chunks')
      return null
    } finally {
      setSaving(false)
    }
  }, [chunks, selectedDoc, mdFilename, settings])

  /**
   * Force a fresh re-chunk with the currently configured splitter.
   *
   * Used by the "Regenerate" button — the auto-chunking effect skips work
   * when the (doc, MD, settings) signature hasn't changed, so an explicit
   * trigger is needed when the user wants to rebuild the chunk list with
   * the same algorithm (after editing chunks in memory, for example).
   */
  const rechunk = useCallback(() => {
    if (!selectedDoc || !hasMarkdown) return
    chunkContent(selectedDoc, settings, mdFilename)
  }, [selectedDoc, hasMarkdown, mdFilename, settings, chunkContent])

  /**
   * Load a previously-saved chunks JSON file by filename.  Replaces the
   * in-memory chunk list with the saved version so the user can inspect
   * it alongside (or in place of) freshly-generated chunks.
   */
  const loadSavedChunks = useCallback(async (chunksFilename: string) => {
    const filename = selectedDoc
    if (!filename) return

    // Abort any in-flight live re-chunk AND any earlier loadSavedChunks
    // request — a quick succession of dropdown clicks must always end up
    // displaying the latest selection.
    chunkAbortRef.current?.abort()
    loadAbortRef.current?.abort()
    const abortCtrl = new AbortController()
    loadAbortRef.current = abortCtrl
    setChunking(false)
    try {
      const loaded = await loadSavedChunksFile(filename, chunksFilename, abortCtrl.signal)
      // Race guard: only commit state if this controller is still the active
      // one — otherwise a slower earlier request could overwrite the newer
      // selection.
      if (loadAbortRef.current !== abortCtrl || selectedDocRef.current !== filename) return
      replaceChunkSet(loaded.chunks, loaded.sourceHash)
      setChunksDirty(false)
      // Mark the live config as already "satisfied" by these saved chunks
      // so the chunking effect doesn't fire fresh re-chunking the next time
      // the panel is reopened.  Routing both call sites through the shared
      // helper guarantees the format stays identical to the effect's sig.
      chunkedSigRef.current = buildChunkConfigSignature(
        selectedDoc, mdFilename, currentMdSource, settings, availableChunks.length, mdContentRevision,
      )
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      toastRef.current.onError('Failed to load saved chunks')
    }
  }, [selectedDoc, mdFilename, mdContentRevision, settings, currentMdSource, availableChunks, replaceChunkSet])

  const enrichChunk = useCallback((index: number, updates: Partial<Chunk>) => {
    setChunks(prev => {
      if (!prev) return prev
      const updated = [...prev]
      updated[index] = { ...updated[index], ...updates }
      return updated
    })
    setChunksDirty(true)
  }, [])

  return {
    chunks, settings, saving, chunking, chunksDirty, chunkRevision,
    cancelChunking, applySettings,
    editChunk, deleteChunk, deleteChunks, mergeChunks, saveChunks, enrichChunk,
    loadSavedChunks, rechunk,
  }
}
