import { useCallback, useEffect, useRef, useState } from 'react'
import { VIEWER_PAGE_SYNC, VIEWER_SCROLL } from '../utils/viewerEvents'
import { positionAt, scrollTarget, type PageOffset, type ViewerPosition } from '../utils/viewerPosition'

interface Options {
  enabled: boolean
  source: 'pdf' | 'markdown' | 'chunks'
  scope: string
  containerRef: React.RefObject<HTMLDivElement | null>
  pageAware?: boolean
  layoutKey?: string | number
  onExternalScroll?: (percentage: number) => void
  onViewportChange?: () => void
}
interface ScrollMessage extends ViewerPosition { source: string; scope: string }
interface PageMessage { source: string; scope: string; page: number; percentage?: number; force?: boolean }

/** One controller owns scroll feedback, page requests, and reflow anchoring. */
export function useScrollSync(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const [currentPage, setCurrentPage] = useState(1)
  const applying = useRef(false)
  const guardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scrollFrame = useRef<number | undefined>(undefined)
  const layoutFrame = useRef<number | undefined>(undefined)
  const preferred = useRef<ViewerPosition | null>(null)
  const cachedPages = useRef<PageOffset[] | null>(null)

  const pages = useCallback(() => {
    const { containerRef, pageAware } = latest.current
    const container = containerRef.current
    if (!container || !pageAware) return []
    if (cachedPages.current) return cachedPages.current
    const origin = container.getBoundingClientRect().top + container.clientTop
    cachedPages.current = Array.from(container.querySelectorAll<HTMLElement>('[data-viewer-page]')).map(element => ({
      page: Number(element.dataset.viewerPage),
      top: element.getBoundingClientRect().top - origin + container.scrollTop,
      height: element.getBoundingClientRect().height,
    }))
    return cachedPages.current
  }, [])

  const measure = useCallback(() => {
    const element = latest.current.containerRef.current
    return element ? positionAt(element.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight), pages()) : { percentage: 0 }
  }, [pages])

  const apply = useCallback((position: ViewerPosition) => {
    const { containerRef, onExternalScroll, onViewportChange } = latest.current
    preferred.current = position
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    clearTimeout(guardTimer.current)
    applying.current = true
    const element = containerRef.current
    if (element && element.clientHeight > 0) {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
      const top = scrollTarget(position, maximum, pages())
      element.scrollTo({ top, behavior: 'instant' })
      onExternalScroll?.(maximum > 0 ? top / maximum : 0)
      onViewportChange?.()
    }
    if (position.page) setCurrentPage(position.page)
    guardTimer.current = setTimeout(() => { applying.current = false }, 80)
  }, [pages])

  const navigate = useCallback((page: number, force = false) => {
    if (!Number.isInteger(page) || page < 1) return
    apply({ page, progress: 0, percentage: measure().percentage })
    const { source, scope, enabled } = latest.current
    if (enabled || force) window.dispatchEvent(new CustomEvent<PageMessage>(VIEWER_PAGE_SYNC, { detail: { source, scope, page, force, percentage: measure().percentage } }))
  }, [apply, measure])

  const handleScroll = useCallback(() => {
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      const { containerRef, source, scope, enabled, onViewportChange } = latest.current
      onViewportChange?.()
      const element = containerRef.current
      if (!element || element.clientHeight <= 0 || applying.current) return
      const position = measure()
      preferred.current = position
      if (position.page) setCurrentPage(position.page)
      if (enabled) window.dispatchEvent(new CustomEvent<ScrollMessage>(VIEWER_SCROLL, { detail: { source, scope, ...position } }))
    })
  }, [measure])

  useEffect(() => {
    const { source, scope, containerRef } = latest.current
    preferred.current = null
    cachedPages.current = null
    setCurrentPage(1)
    const accepts = (message: { source: string; scope: string }) => message.scope === scope && message.source !== source
      && (source === 'pdf' ? message.source === 'markdown' || message.source === 'chunks' : message.source === 'pdf')
    const scroll = (event: Event) => {
      const message = (event as CustomEvent<ScrollMessage>).detail
      if (!message || !accepts(message) || !latest.current.enabled) return
      if (!Number.isFinite(message.percentage)) return
      apply(message)
    }
    const page = (event: Event) => {
      const message = (event as CustomEvent<PageMessage>).detail
      if (!message || !accepts(message) || (!latest.current.enabled && !message.force)) return
      if (!Number.isInteger(message.page) || message.page < 1) return
      apply({ page: message.page, progress: 0, percentage: Number.isFinite(message.percentage) ? message.percentage! : measure().percentage })
    }
    const takeControl = () => {
      clearTimeout(guardTimer.current)
      applying.current = false
      preferred.current = null
    }
    const element = containerRef.current
    const gestures = ['wheel', 'pointerdown', 'touchstart', 'keydown']
    gestures.forEach(name => element?.addEventListener(name, takeControl, { passive: true }))
    window.addEventListener(VIEWER_SCROLL, scroll)
    window.addEventListener(VIEWER_PAGE_SYNC, page)
    return () => {
      window.removeEventListener(VIEWER_SCROLL, scroll)
      window.removeEventListener(VIEWER_PAGE_SYNC, page)
      gestures.forEach(name => element?.removeEventListener(name, takeControl))
      clearTimeout(guardTimer.current)
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current)
      if (layoutFrame.current !== undefined) cancelAnimationFrame(layoutFrame.current)
      applying.current = false
    }
  }, [options.source, options.scope, options.containerRef, apply, measure])

  useEffect(() => {
    const element = options.containerRef.current
    if (!element) return
    cachedPages.current = null
    const observer = new ResizeObserver(() => {
      cachedPages.current = null
      if (layoutFrame.current !== undefined) cancelAnimationFrame(layoutFrame.current)
      layoutFrame.current = requestAnimationFrame(() => {
        if (preferred.current) apply(preferred.current)
        else {
          const position = measure()
          if (position.page) setCurrentPage(position.page)
        }
      })
    })
    observer.observe(element)
    for (const child of element.querySelectorAll('[data-viewer-page], .markdown-content, .chunk-list')) observer.observe(child)
    return () => observer.disconnect()
  }, [options.containerRef, options.layoutKey, options.pageAware, options.scope, apply, measure])

  return { handleScroll, currentPage, navigate }
}
