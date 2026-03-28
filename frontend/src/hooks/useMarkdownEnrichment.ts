import { useState, useRef, useEffect } from 'react'
import type { EnrichmentSettings, EnrichOp } from '../types'
import { apiEnrichMarkdown } from '../services/apiService'
import { CONNECTION_LOST_MSG } from '../utils/parseSse'

// ── Types exported for use in MarkdownViewer ─────────────────────────────────

export interface MdBlock {
  heading: string
  content: string
  startLine: number
  endLine: number
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function splitIntoBlocks(markdown: string): MdBlock[] {
  const lines = markdown.split('\n')
  const headingPositions: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) headingPositions.push(i)
  }
  if (headingPositions.length === 0) {
    return [{ heading: '', content: markdown, startLine: 0, endLine: lines.length - 1 }]
  }
  const starts = headingPositions[0] > 0 ? [0, ...headingPositions] : headingPositions
  return starts.map((startLine, i) => {
    const endLine = i + 1 < starts.length ? starts[i + 1] - 1 : lines.length - 1
    const content = lines.slice(startLine, endLine + 1).join('\n')
    const heading = /^#{1,6}\s/.test(lines[startLine]) ? lines[startLine] : ''
    return { heading, content, startLine, endLine }
  })
}

// ── Hook ─────────────────────────────────────────────────────────────────────

interface Options {
  sectionEnrichment?: EnrichmentSettings
  /** Current value of editMode in MarkdownViewer. */
  editMode: boolean
  /** Current value of editContent in MarkdownViewer. */
  editContent: string
  /** Original content prop. */
  content: string
  /** Stable setter from useState — never re-created. */
  setEditContent: (content: string) => void
  /** Stable setter from useState — never re-created. */
  setEditMode: (mode: boolean) => void
  /** Callback to display a configuration / stream error in the viewer. */
  setEnrichError: (msg: string | null) => void
}

export interface UseMarkdownEnrichmentReturn {
  mdEnrichOp: EnrichOp | null
  /** Non-null when there is content to undo. Pass to the Undo button's disabled check. */
  preEnrichContent: string | null
  pickerOpen: boolean
  pickerBlocks: MdBlock[]
  pickerSelected: Set<number>
  setPickerOpen: (v: boolean) => void
  setPickerSelected: (s: Set<number>) => void
  handleInterruptMdEnrich: () => void
  /** Opens the section picker (or enriches directly if only one block). */
  handleEnrichSection: () => void
  /** Reverts editContent to the pre-enrichment snapshot. */
  handleUndoEnrich: () => void
  /** Clears the pre-enrich snapshot (call after save / cancel). */
  clearPreEnrich: () => void
  /** Called when the user confirms the section picker. */
  confirmPicker: () => void
}

export function useMarkdownEnrichment({
  sectionEnrichment,
  editMode,
  editContent,
  content,
  setEditContent,
  setEditMode,
  setEnrichError,
}: Options): UseMarkdownEnrichmentReturn {
  const [mdEnrichOp, setMdEnrichOp] = useState<EnrichOp | null>(null)
  const [preEnrichContent, setPreEnrichContent] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerBlocks, setPickerBlocks] = useState<MdBlock[]>([])
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set())
  const mdEnrichAbortRef = useRef<AbortController | null>(null)

  // Refs so that stable event-handler closures always read the latest values
  // without needing them in useCallback dependency arrays.
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode
  const editContentRef = useRef(editContent)
  editContentRef.current = editContent
  const contentRef = useRef(content)
  contentRef.current = content

  // Clear picker and pre-enrich snapshot when the document content changes
  // (document switch, conversion, etc.).
  useEffect(() => {
    setPreEnrichContent(null)
    setPickerOpen(false)
    setPickerBlocks([])
    setPickerSelected(new Set())
  }, [content])

  // ── Core enrichment loop ─────────────────────────────────────────────────

  const startMdEnrichment = async (
    currentContent: string,
    blocks: MdBlock[],
    selectedIndices: number[],
  ) => {
    if (!sectionEnrichment) return

    const abortCtrl = new AbortController()
    mdEnrichAbortRef.current = abortCtrl

    setPreEnrichContent(currentContent)
    setMdEnrichOp({ title: 'Markdown Enrichment', detail: '', current: 0, total: selectedIndices.length })
    // Switch to edit mode so enriched content is visible as it arrives.
    setEditMode(true)

    const enrichedBlocks = blocks.map(b => b.content)

    try {
      for (let i = 0; i < selectedIndices.length; i++) {
        if (abortCtrl.signal.aborted) break

        const blockIdx = selectedIndices[i]
        const block = blocks[blockIdx]
        const displayName = block.heading.replace(/^#{1,6}\s+/, '') || 'Introduction'

        setMdEnrichOp(prev => prev
          ? { ...prev, detail: `Block ${i + 1} of ${selectedIndices.length} — ${displayName}`, current: i + 1, errorMessage: undefined }
          : null
        )

        try {
          enrichedBlocks[blockIdx] = await apiEnrichMarkdown(
            sectionEnrichment,
            block.content,
            abortCtrl.signal,
            () => setMdEnrichOp(prev => prev ? { ...prev, errorMessage: CONNECTION_LOST_MSG } : null),
          )
          setEditContent(enrichedBlocks.join('\n'))
        } catch (err) {
          if ((err as DOMException).name === 'AbortError') break
          // Per-block error: keep original content and continue with the next block.
        }
      }
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') {
        setMdEnrichOp(prev => prev
          ? { ...prev, errorMessage: err instanceof Error ? err.message : 'Stream error' }
          : null
        )
        mdEnrichAbortRef.current = null
        return
      }
    }

    setMdEnrichOp(null)
    mdEnrichAbortRef.current = null
  }

  // ── Public handlers ──────────────────────────────────────────────────────

  const handleInterruptMdEnrich = () => {
    mdEnrichAbortRef.current?.abort()
    setMdEnrichOp(null)
  }

  const handleEnrichSection = () => {
    if (!sectionEnrichment?.model) {
      setEnrichError('Configure Section Enrichment (model) in Settings → Enrichment tab.')
      return
    }
    setEnrichError(null)
    // Use refs to read the latest values — this is a click handler, not an effect.
    const currentContent = editModeRef.current ? editContentRef.current : contentRef.current
    const blocks = splitIntoBlocks(currentContent)

    if (blocks.length <= 1) {
      startMdEnrichment(currentContent, blocks, [0])
    } else {
      setPickerBlocks(blocks)
      setPickerSelected(new Set(blocks.map((_, i) => i)))
      setPickerOpen(true)
    }
  }

  const handleUndoEnrich = () => {
    if (preEnrichContent !== null) {
      setEditContent(preEnrichContent)
      setPreEnrichContent(null)
    }
  }

  const clearPreEnrich = () => setPreEnrichContent(null)

  const confirmPicker = () => {
    const currentContent = editModeRef.current ? editContentRef.current : contentRef.current
    const indices = Array.from(pickerSelected).sort((a, b) => a - b)
    setPickerOpen(false)
    startMdEnrichment(currentContent, pickerBlocks, indices)
  }

  return {
    mdEnrichOp,
    preEnrichContent,
    pickerOpen,
    pickerBlocks,
    pickerSelected,
    setPickerOpen,
    setPickerSelected,
    handleInterruptMdEnrich,
    handleEnrichSection,
    handleUndoEnrich,
    clearPreEnrich,
    confirmPicker,
  }
}
