import Modal from '../common/Modal'
import Button from '../common/Button'
import ViewTabs from '../common/ViewTabs'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineResult } from '../../services/apiService'
import './EnrichDiffModal.css'

interface Props {
  isOpen: boolean
  original: string
  result: PipelineResult | null
  /** Called with the (possibly user-edited) enriched content. */
  onAccept: (content: string) => Promise<void> | void
  onReject: () => void
  onClose: () => void
  saving?: boolean
}

// ── Line-level diff ─────────────────────────────────────────────────────────

type SegOp = 'equal' | 'insert' | 'delete'

interface Segment {
  op: SegOp
  leftLine: number | null   // 1-indexed, null when op === 'insert'
  rightLine: number | null  // 1-indexed, null when op === 'delete'
  text: string
}

/**
 * Standard LCS line-level diff.  Returns a flat list of segments where
 * each entry corresponds to exactly one line on either or both sides.
 *
 * O(n·m) time and space. The caller bounds both character count and
 * matrix size before computing the diff; larger documents use Edit.
 */
function lineDiff(left: string, right: string): Segment[] {
  const lhs = left.split('\n')
  const rhs = right.split('\n')
  const n = lhs.length
  const m = rhs.length

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = lhs[i] === rhs[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: Segment[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (lhs[i] === rhs[j]) {
      out.push({ op: 'equal', leftLine: i + 1, rightLine: j + 1, text: lhs[i] })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'delete', leftLine: i + 1, rightLine: null, text: lhs[i] })
      i++
    } else {
      out.push({ op: 'insert', leftLine: null, rightLine: j + 1, text: rhs[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ op: 'delete', leftLine: i + 1, rightLine: null, text: lhs[i] })
    i++
  }
  while (j < m) {
    out.push({ op: 'insert', leftLine: null, rightLine: j + 1, text: rhs[j] })
    j++
  }
  return out
}

// ── Side-by-side row construction ──────────────────────────────────────────

type RowKind = 'equal' | 'modify' | 'delete' | 'insert' | 'collapsed'

interface Row {
  kind: RowKind
  leftLine: number | null
  rightLine: number | null
  leftText: string
  rightText: string
  /** Only set when kind === 'collapsed'. */
  collapsed?: number
}

/**
 * Pair adjacent (delete, insert) segments into a single 'modify' row so the
 * side-by-side view shows the old line next to the replacement instead of
 * spreading them across two rows with one column blank.  Pure deletes and
 * pure inserts keep their own row with the opposite column empty.
 *
 * After pairing, long runs of equal rows are collapsed to a "… N unchanged
 * lines …" placeholder with ``CONTEXT_LINES`` of surrounding context on each
 * side of a changed region — same approach git diff uses for readability.
 */
const CONTEXT_LINES = 3

function buildRows(segments: Segment[]): Row[] {
  // First pass: pair adjacent delete+insert into modify rows.
  const paired: Row[] = []
  let i = 0
  while (i < segments.length) {
    const s = segments[i]
    if (s.op === 'delete' && i + 1 < segments.length && segments[i + 1].op === 'insert') {
      const next = segments[i + 1]
      paired.push({
        kind: 'modify',
        leftLine: s.leftLine,
        rightLine: next.rightLine,
        leftText: s.text,
        rightText: next.text,
      })
      i += 2
      continue
    }
    if (s.op === 'equal') {
      paired.push({ kind: 'equal', leftLine: s.leftLine, rightLine: s.rightLine, leftText: s.text, rightText: s.text })
    } else if (s.op === 'delete') {
      paired.push({ kind: 'delete', leftLine: s.leftLine, rightLine: null, leftText: s.text, rightText: '' })
    } else {
      paired.push({ kind: 'insert', leftLine: null, rightLine: s.rightLine, leftText: '', rightText: s.text })
    }
    i++
  }

  // Second pass: collapse long equal runs.
  const collapsed: Row[] = []
  let k = 0
  while (k < paired.length) {
    if (paired[k].kind !== 'equal') {
      collapsed.push(paired[k])
      k++
      continue
    }
    // Walk the equal run.
    let runEnd = k
    while (runEnd < paired.length && paired[runEnd].kind === 'equal') runEnd++
    const runLen = runEnd - k

    if (runLen <= CONTEXT_LINES * 2 + 1) {
      // Short enough to show entirely.
      for (let r = k; r < runEnd; r++) collapsed.push(paired[r])
    } else {
      const isFirst = collapsed.length === 0
      const isLast = runEnd === paired.length
      // Leading context (after the previous change) — skip if this is the
      // first run (no prior change to provide context for).
      if (!isFirst) {
        for (let r = k; r < k + CONTEXT_LINES; r++) collapsed.push(paired[r])
      }
      const hiddenStart = isFirst ? k : k + CONTEXT_LINES
      const hiddenEnd = isLast ? runEnd : runEnd - CONTEXT_LINES
      const hidden = hiddenEnd - hiddenStart
      if (hidden > 0) {
        collapsed.push({
          kind: 'collapsed',
          leftLine: null,
          rightLine: null,
          leftText: '',
          rightText: '',
          collapsed: hidden,
        })
      }
      // Trailing context (before the next change) — skip if this is the last run.
      if (!isLast) {
        for (let r = runEnd - CONTEXT_LINES; r < runEnd; r++) collapsed.push(paired[r])
      }
    }
    k = runEnd
  }
  return collapsed
}

// ── Component ───────────────────────────────────────────────────────────────

const MAX_DIFF_CHARS = 4_000_000
const MAX_DIFF_CELLS = 2_000_000

function lineCount(content: string): number {
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++
  }
  return count
}

export default function EnrichDiffModal({
  isOpen,
  original,
  result,
  onAccept,
  onReject,
  onClose,
  saving = false,
}: Props) {
  const [tab, setTab] = useState<'diff' | 'edit'>('diff')
  const [editedContent, setEditedContent] = useState<string>('')

  // Re-seed the editable buffer every time a new pipeline result arrives
  // so accept-then-rerun doesn't keep stale edits around.  The dependency
  // is the pipeline result object identity (not the content) so editing
  // doesn't blow away the user's in-progress edits.
  useEffect(() => {
    setEditedContent(result?.enrichedContent ?? '')
    setTab('diff')
  }, [result])

  const tooLarge = useMemo(() => {
    if (!result) return false
    return original.length + editedContent.length > MAX_DIFF_CHARS
      || (lineCount(original) + 1) * (lineCount(editedContent) + 1) > MAX_DIFF_CELLS
  }, [original, editedContent, result])

  const rows = useMemo<Row[]>(() => {
    if (!isOpen || !result || tooLarge || tab !== 'diff') return []
    const segments = lineDiff(original, editedContent)
    return buildRows(segments)
  }, [isOpen, original, editedContent, result, tooLarge, tab])

  const hasChanges = useMemo(() => rows.some(r => r.kind !== 'equal' && r.kind !== 'collapsed'), [rows])

  const stats = result?.stats

  if (!isOpen || !result) return null

  return (
    <Modal open={isOpen} onClose={onClose} title="Review enrichment changes" className="enrich-diff-modal" dismissible={!saving}>
        <div className="enrich-diff-header">
          <div>
            {stats && (
              <div className="enrich-diff-stats">
                <span><strong>{stats.pieces}</strong> piece{stats.pieces !== 1 ? 's' : ''}</span>
                {stats.cached_pieces > 0 && <span> · <strong>{stats.cached_pieces}</strong> from cache</span>}
                {stats.failed_pieces.length > 0 && (
                  <span className="enrich-diff-failed"> · <strong>{stats.failed_pieces.length}</strong> failed (kept original)</span>
                )}
                {stats.cleanup && stats.cleanup.total_changes > 0 && (
                  <span> · <strong>{stats.cleanup.total_changes}</strong> cleanup change{stats.cleanup.total_changes !== 1 ? 's' : ''}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <ViewTabs label="Enrichment review view" value={tab} onChange={setTab}
          variant="segmented" className="enrich-diff-tabs" items={[
            { value: 'diff', label: 'Side-by-side diff' },
            { value: 'edit', label: 'Edit' },
          ]} />

        {tab === 'diff'
          ? <DiffView rows={rows} tooLarge={tooLarge} hasChanges={hasChanges} />
          : <EditView original={original} edited={editedContent} onChange={setEditedContent} />}


        <div className="ui-modal-footer enrich-diff-footer">
          <Button onClick={onReject} disabled={saving}>Reject</Button>
          <Button variant="primary" onClick={() => onAccept(editedContent)} loading={saving}>
            {saving ? 'Saving…' : 'Accept and save'}
          </Button>
        </div>
    </Modal>
  )
}

// ── Diff view (side-by-side, colored, read-only) ────────────────────────────

function DiffView({ rows, tooLarge, hasChanges }: { rows: Row[]; tooLarge: boolean; hasChanges: boolean }) {
  if (tooLarge) {
    return (
      <div className="enrich-diff-body">
        <div className="enrich-diff-notice">
          Document is too large to compute a line-by-line diff in the browser.
          Switch to the <em>Edit</em> tab to review and adjust the enriched content.
        </div>
      </div>
    )
  }
  if (!hasChanges) {
    return (
      <div className="enrich-diff-body">
        <div className="enrich-diff-notice">
          No changes detected — the enriched output matches the original byte-for-byte.
        </div>
      </div>
    )
  }
  return (
    <div className="enrich-diff-body">
      <div className="enrich-diff-grid" role="table" aria-label="Side-by-side diff">
        <div className="enrich-diff-col-header">Original</div>
        <div className="enrich-diff-col-header">Enriched</div>
        {rows.map((row, idx) => {
          if (row.kind === 'collapsed') {
            return (
              <div key={idx} className="enrich-diff-skip-row" style={{ gridColumn: '1 / span 2' }}>
                … {row.collapsed} unchanged line{row.collapsed === 1 ? '' : 's'} …
              </div>
            )
          }
          const leftCls = row.kind === 'delete' || row.kind === 'modify' ? 'changed-left' : ''
          const rightCls = row.kind === 'insert' || row.kind === 'modify' ? 'changed-right' : ''
          const isEmpty = (text: string) => text.length === 0
          return (
            <Row
              key={idx}
              leftLine={row.leftLine}
              rightLine={row.rightLine}
              leftText={row.leftText}
              rightText={row.rightText}
              leftCls={leftCls}
              rightCls={rightCls}
              leftEmpty={row.kind === 'insert' && isEmpty(row.leftText)}
              rightEmpty={row.kind === 'delete' && isEmpty(row.rightText)}
            />
          )
        })}
      </div>
    </div>
  )
}

interface RowProps {
  leftLine: number | null
  rightLine: number | null
  leftText: string
  rightText: string
  leftCls: string
  rightCls: string
  leftEmpty: boolean
  rightEmpty: boolean
}

function Row({ leftLine, rightLine, leftText, rightText, leftCls, rightCls, leftEmpty, rightEmpty }: RowProps) {
  return (
    <>
      <div className={`enrich-diff-cell ${leftCls} ${leftEmpty ? 'empty' : ''}`}>
        <span className="enrich-diff-line-num">{leftLine ?? ''}</span>
        <span className="enrich-diff-line-text">{leftText}</span>
      </div>
      <div className={`enrich-diff-cell ${rightCls} ${rightEmpty ? 'empty' : ''}`}>
        <span className="enrich-diff-line-num">{rightLine ?? ''}</span>
        <span className="enrich-diff-line-text">{rightText}</span>
      </div>
    </>
  )
}

// ── Edit view (side-by-side, right column editable) ─────────────────────────

function EditView({ original, edited, onChange }: { original: string; edited: string; onChange: (v: string) => void }) {
  const leftRef = useRef<HTMLTextAreaElement>(null)
  const rightRef = useRef<HTMLTextAreaElement>(null)
  const [scrollSync, setScrollSync] = useState(true)

  // Scroll-sync: when one textarea scrolls, mirror the position on the
  // other so the two columns track the same region of the document.  Uses
  // refs (not state) so typing isn't slowed by extra renders.  The user
  // can disable this when they want to read one side independently — e.g.
  // hold position on the original while scrolling the edited buffer.
  useEffect(() => {
    if (!scrollSync) return
    const l = leftRef.current
    const r = rightRef.current
    if (!l || !r) return
    let syncing = false
    const onLeftScroll = () => {
      if (syncing) return
      syncing = true
      r.scrollTop = l.scrollTop
      requestAnimationFrame(() => { syncing = false })
    }
    const onRightScroll = () => {
      if (syncing) return
      syncing = true
      l.scrollTop = r.scrollTop
      requestAnimationFrame(() => { syncing = false })
    }
    l.addEventListener('scroll', onLeftScroll)
    r.addEventListener('scroll', onRightScroll)
    return () => {
      l.removeEventListener('scroll', onLeftScroll)
      r.removeEventListener('scroll', onRightScroll)
    }
  }, [scrollSync])

  return (
    <div className="enrich-diff-body">
      <div className="enrich-diff-edit-toolbar">
        <label className="enrich-diff-sync-toggle">
          <input
            type="checkbox"
            checked={scrollSync}
            onChange={e => setScrollSync(e.target.checked)}
          />
          <span>Synchronised scroll</span>
        </label>
      </div>
      <div className="enrich-diff-edit-grid">
        <div className="enrich-diff-col-header enrich-diff-original-heading">Original (read-only)</div>
        <div className="enrich-diff-col-header enrich-diff-enriched-heading">Enriched (editable)</div>
        <textarea
          ref={leftRef}
          className="enrich-diff-textarea"
          value={original}
          readOnly
          spellCheck={false}
          aria-label="Original content (read-only)"
        />
        <textarea
          ref={rightRef}
          className="enrich-diff-textarea"
          value={edited}
          onChange={e => onChange(e.target.value)}
          spellCheck={false}
          aria-label="Enriched content (editable)"
        />
      </div>
    </div>
  )
}
