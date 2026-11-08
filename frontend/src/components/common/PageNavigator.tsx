import { useEffect, useState } from 'react'
import { clamp } from '../../utils/viewerPosition'
import './PageNavigator.css'

export default function PageNavigator({ page, total, label, onSelect }: {
  page: number; total: number; label: string; onSelect: (page: number) => void
}) {
  const current = clamp(page, 1, Math.max(1, total))
  const [draft, setDraft] = useState(String(current))
  useEffect(() => setDraft(String(current)), [current])
  if (total < 1) return null
  const commit = () => {
    if (!draft.trim() || !Number.isFinite(Number(draft))) { setDraft(String(current)); return }
    const target = clamp(Math.trunc(Number(draft)), 1, total)
    setDraft(String(target))
    if (target !== current) onSelect(target)
  }
  return (
    <div className="page-navigator" role="group" aria-label={`${label} page navigation`}>
      <button type="button" aria-label={`Previous ${label} page`} title="Previous page" disabled={current <= 1} onClick={() => onSelect(current - 1)}>‹</button>
      <span>Page</span>
      <input type="number" aria-label={`${label} page`} min={1} max={total} value={draft}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} />
      <span>of {total}</span>
      <button type="button" aria-label={`Next ${label} page`} title="Next page" disabled={current >= total} onClick={() => onSelect(current + 1)}>›</button>
    </div>
  )
}
