/**
 * Frontend-wide tunables.  Centralised here so values that affect UX, lazy
 * rendering, networking, or styling can be tweaked without grepping the
 * codebase.  Anything magic that appears in more than one component should
 * live in this file.
 */

// ── Networking ─────────────────────────────────────────────────────────────

/** Timeout for ad-hoc metadata fetches (e.g. /documents/metadata). */
export const METADATA_FETCH_TIMEOUT_MS = 5000

// ── Toast notifications ────────────────────────────────────────────────────

export const TOAST_DURATION_SUCCESS_MS = 4000
export const TOAST_DURATION_ERROR_MS = 10000

// ── Lazy rendering ─────────────────────────────────────────────────────────

/** rootMargin used by IntersectionObserver to pre-render content slightly
 *  outside the viewport so scrolling feels seamless. */
export const LAZY_OBSERVER_MARGIN = '300px'

/** Target byte size for splitting markdown into lazy sections. */
export const LAZY_SECTION_TARGET_CHARS = 2500

/** Coefficient and clamps for estimating chunk-block height before render. */
export const CHUNK_HEIGHT_MIN_PX = 100
export const CHUNK_HEIGHT_MAX_PX = 800
export const CHUNK_HEIGHT_PX_PER_CHAR = 0.4

// ── PDF viewer ─────────────────────────────────────────────────────────────

/** Pages to pre-render above and below the visible viewport. */
export const PDF_RENDER_BUFFER = 2

/** Number of pages fetched in parallel when computing dimensions. */
export const PDF_DIM_BATCH = 20

// ── Chunk operations ───────────────────────────────────────────────────────

/** Tail length scanned when detecting overlap between adjacent chunks during
 *  merge. Larger values catch longer overlaps at the cost of more comparisons. */
export const CHUNK_OVERLAP_SCAN_TAIL = 300

// ── Chunk colours ──────────────────────────────────────────────────────────

export const CHUNK_COLORS = [
  'rgba(99, 102, 241, 0.06)',
  'rgba(16, 185, 129, 0.06)',
  'rgba(245, 158, 11, 0.06)',
  'rgba(59, 130, 246, 0.06)',
  'rgba(139, 92, 246, 0.06)',
  'rgba(244, 63, 94, 0.06)',
  'rgba(6, 182, 212, 0.06)',
  'rgba(20, 184, 166, 0.06)',
  'rgba(249, 115, 22, 0.06)',
  'rgba(100, 116, 139, 0.06)',
]

export const CHUNK_BORDER_COLORS = [
  '#6366F1', '#10B981', '#F59E0B', '#3B82F6', '#8B5CF6',
  '#F43F5E', '#06B6D4', '#14B8A6', '#F97316', '#64748B',
]
