export interface PageOffset { page: number; top: number; height: number }
export interface ViewerPosition { percentage: number; page?: number; progress?: number }
export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

export function positionAt(scrollTop: number, maximum: number, pages: PageOffset[]): ViewerPosition {
  const percentage = maximum > 0 ? clamp(scrollTop / maximum, 0, 1) : 0
  if (!pages.length) return { percentage }
  let index = 0
  for (let next = 1; next < pages.length && pages[next].top <= scrollTop + 1; next++) index = next
  const current = pages[index]
  const height = (pages[index + 1]?.top ?? current.top + current.height) - current.top
  return { percentage, page: current.page, progress: height > 0 ? clamp((scrollTop - current.top) / height, 0, 1) : 0 }
}

export function scrollTarget(position: ViewerPosition, maximum: number, pages: PageOffset[]): number {
  const index = pages.findIndex(item => item.page === position.page)
  if (index < 0) return Math.round(clamp(position.percentage, 0, 1) * maximum)
  const current = pages[index]
  const height = (pages[index + 1]?.top ?? current.top + current.height) - current.top
  return clamp(current.top + clamp(position.progress ?? 0, 0, 1) * height, 0, maximum)
}
