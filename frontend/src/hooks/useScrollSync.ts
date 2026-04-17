import { useCallback, useEffect, useRef } from 'react'
import { VIEWER_SCROLL } from '../utils/viewerEvents'

/** Debounce duration after an external scroll before re-enabling self-dispatch. */
export const SCROLL_DEBOUNCE_MS = 50

/** Clamp a value to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Shared scroll-sync hook for MarkdownViewer and ChunkViewer.
 *
 * Handles:
 * - Dispatching VIEWER_SCROLL events when the user scrolls this viewer.
 * - Listening for VIEWER_SCROLL events from other viewers and scrolling to match.
 * - Debouncing the external-scroll guard so self-dispatch is suppressed only
 *   while the programmatic scroll animation is in flight.
 * - Cleaning up the debounce timeout on unmount and on deps change.
 *
 * @param enabled       Whether scroll sync is active.
 * @param source        The `detail.source` value this viewer emits (e.g. `'markdown'`).
 * @param listenSource  The `detail.source` value this viewer reacts to (e.g. `'pdf'`).
 * @param containerRef  Ref to the scrollable container element.
 * @param onExternalScroll  Optional callback fired after a programmatic scroll,
 *                          receiving the target percentage. Used by MarkdownViewer
 *                          to keep `savedScrollRatioRef` in sync.
 */
export function useScrollSync(
  enabled: boolean,
  source: string,
  listenSource: string,
  containerRef: React.RefObject<HTMLDivElement>,
  onExternalScroll?: (percentage: number) => void,
) {
  const isScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const rafRef = useRef<number>()

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingRef.current || !enabled) return
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const el = e.target as HTMLDivElement
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) return
      const pct = clamp(el.scrollTop / maxScroll, 0, 1)
      window.dispatchEvent(new CustomEvent(VIEWER_SCROLL, {
        detail: { source, percentage: pct },
      }))
    })
  }, [enabled, source])

  useEffect(() => {
    const onExtScroll = (e: Event) => {
      const ev = e as CustomEvent<{ source: string; percentage: number }>
      if (ev.detail.source !== listenSource || !containerRef.current || !enabled) return
      isScrollingRef.current = true
      clearTimeout(scrollTimeoutRef.current)
      const el = containerRef.current
      const maxScroll = el.scrollHeight - el.clientHeight
      if (maxScroll <= 0) { isScrollingRef.current = false; return }
      const pct = clamp(ev.detail.percentage, 0, 1)
      el.scrollTo({ top: Math.round(pct * maxScroll), behavior: 'instant' })
      onExternalScroll?.(pct)
      scrollTimeoutRef.current = setTimeout(() => { isScrollingRef.current = false }, SCROLL_DEBOUNCE_MS)
    }
    window.addEventListener(VIEWER_SCROLL, onExtScroll)
    return () => {
      window.removeEventListener(VIEWER_SCROLL, onExtScroll)
      clearTimeout(scrollTimeoutRef.current)
    }
  }, [enabled, listenSource, containerRef, onExternalScroll])

  // Expose rafRef so the host component can cancel it on unmount if needed.
  return { handleScroll, rafRef, scrollTimeoutRef }
}
