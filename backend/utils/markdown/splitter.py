"""
Structure-aware markdown splitter for the enrichment pipeline.

Splits a markdown document into pieces sized for an LLM's context window
while *never* cutting across structurally significant boundaries.  In
practice that means:

    * Never split inside a fenced code block.
    * Never split inside a markdown table.
    * Never split inside a contiguous list group (consecutive list items
      and any nested content immediately under them).
    * Prefer splitting at heading boundaries (H1, then H2, then H3, …) so
      pieces are semantically coherent.
    * Fall back to paragraph (blank-line) boundaries when no heading
      candidate exists in range.
    * Fall back to absolute size cap only when the document has *no* safe
      boundary at all (e.g. one massive paragraph with no headings or
      blank lines).  This is rare and only happens with pathological
      inputs; the LLM will still get a coherent piece, just at the
      configured max.

The result is a list of :class:`Piece` objects, each carrying its slice
of the original text and the byte-offset span it covers.  The offsets let
the pipeline orchestrator compute the "rolling context" — the last N
characters of the *previous original* piece — without rescanning the
source.  Using the original offsets (not corrected text) avoids the drift
that would happen if each piece's correction fed forward into the next.

Performance: single linear pass; produces ~one piece per 4000-6000 chars
of input.  A 400-page document (~1 MB) yields roughly 150-250 pieces and
splits in well under a second.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Boundary detection patterns
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,6})\s+\S")
_CODE_FENCE_RE = re.compile(r"^\s*```")
_TABLE_LINE_RE = re.compile(r"^\s*\|")
_TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$")
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]\s|\d+\.\s)")
_PAGE_MARKER_RE = re.compile(r"^\s*<!--\s*page-marker:\d+\s*-->\s*$")


# ---------------------------------------------------------------------------
# Piece
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Piece:
    """A contiguous slice of the source markdown.

    ``start`` and ``end`` are absolute character offsets into the source,
    half-open (``source[start:end] == content`` is invariant by
    construction).  They drive the rolling-context lookup performed by
    the pipeline before invoking the LLM on this piece.
    """

    index: int       # 0-based position in the piece list
    content: str
    start: int       # inclusive
    end: int         # exclusive

    @property
    def char_count(self) -> int:
        return len(self.content)


# ---------------------------------------------------------------------------
# Block classification
# ---------------------------------------------------------------------------

# A "block" is the unit we group lines into before computing splits.  Blocks
# are never crossed by a split — only block boundaries are candidate split
# points.  Block kinds influence which boundaries the splitter prefers.

_BlockKind = str  # "heading" | "table" | "code" | "list" | "paragraph" | "marker" | "blank"


@dataclass(slots=True)
class _Block:
    kind: _BlockKind
    heading_level: int           # 0 for non-heading blocks
    start: int                   # byte offset in source
    end: int                     # byte offset in source (exclusive)


def _subsplit_paragraph_offsets(
    md: str, start: int, end: int, target_chars: int,
) -> list[tuple[int, int]]:
    """Break a single paragraph span into sub-paragraph spans <= ``target_chars``.

    A naive PDF→markdown conversion can produce one giant paragraph that
    is larger than ``max_chars``.  Since blocks are atomic in the split
    algorithm, such a block becomes one indivisible piece — defeating
    the size cap entirely.  This helper subdivides at the cheapest
    boundary available: internal newlines first, then whitespace runs,
    then a hard char-cut as a last resort.  Returned spans tile
    ``[start, end)`` exactly so the reassembly invariant holds.
    """
    spans: list[tuple[int, int]] = []
    cursor = start
    while end - cursor > target_chars:
        window_end = min(cursor + target_chars, end)
        text = md[cursor:window_end]
        # 1. last newline inside the window.
        cut = text.rfind("\n")
        # 2. last whitespace inside the window (only consider the right half
        #    so we don't produce a tiny leading slice).
        if cut < target_chars // 2:
            ws_cut = -1
            for i in range(len(text) - 1, target_chars // 2 - 1, -1):
                if text[i].isspace():
                    ws_cut = i
                    break
            if ws_cut > cut:
                cut = ws_cut
        if cut < target_chars // 2:
            # 3. hard char cut at window_end — pathological input.
            spans.append((cursor, window_end))
            cursor = window_end
            continue
        # Land the cut just after the boundary char so the split character
        # belongs to the preceding slice (matches paragraph semantics where
        # the newline ends the previous line).
        boundary = cursor + cut + 1
        spans.append((cursor, boundary))
        cursor = boundary
    if cursor < end:
        spans.append((cursor, end))
    return spans


def _paired_fence_lines(line_spans: list[tuple[int, int, str]]) -> set[int]:
    """Return the set of line indices that are part of a properly-paired
    code fence (open + close).  A stray opening fence with no matching
    closer would otherwise cause every following line to be absorbed
    into one giant code block — which then bypasses the size cap because
    code blocks are atomic.  Treating unpaired fences as literal text
    lets the rest of the document parse normally (headings, paragraphs,
    tables, etc.) and is the correct interpretation of the user-visible
    markdown: a lone ``` with no closer cannot have been intended as a
    code block by any sane authoring path.
    """
    fence_indices = [i for i, (_, _, line) in enumerate(line_spans) if _CODE_FENCE_RE.match(line)]
    paired: set[int] = set()
    j = 0
    while j + 1 < len(fence_indices):
        paired.add(fence_indices[j])
        paired.add(fence_indices[j + 1])
        j += 2
    return paired


def _classify_blocks(md: str, paragraph_max_chars: int | None = None) -> list[_Block]:
    """Single-pass scan that groups lines into atomic blocks.

    The scan is line-oriented but tracks character offsets so each block's
    ``(start, end)`` maps exactly back to the source — including the
    trailing newline.  Code fences and tables are reluctant to close: once
    we enter one, every subsequent line belongs to that block until the
    closing fence (for code) or a blank line (for tables) appears.
    """
    blocks: list[_Block] = []
    in_fence = False
    fence_block_start = -1

    # Pre-compute line spans to avoid splitting then reconstructing offsets.
    line_spans: list[tuple[int, int, str]] = []
    pos = 0
    for line in md.split("\n"):
        end = pos + len(line)
        line_spans.append((pos, end, line))
        pos = end + 1  # the \n we consumed
    # If the source ends without a trailing newline, the last "line" still
    # occupies up to len(md); fine.

    # Pair fences up front so a stray ``` (very common in PDF→markdown
    # output) doesn't swallow the rest of the document into one giant
    # atomic code block.  Unpaired fence lines fall through to the
    # paragraph scanner below as literal text.
    paired_fences = _paired_fence_lines(line_spans)

    i = 0
    while i < len(line_spans):
        ls, le, line = line_spans[i]

        # Code fence: open or close.  Only honour fences that have a
        # matching counterpart — see ``_paired_fence_lines``.
        if _CODE_FENCE_RE.match(line) and i in paired_fences:
            if not in_fence:
                in_fence = True
                fence_block_start = ls
                i += 1
                continue
            # closing fence
            block_end = le + (1 if i + 1 < len(line_spans) else 0)
            blocks.append(_Block("code", 0, fence_block_start, block_end))
            in_fence = False
            i += 1
            continue
        if in_fence:
            i += 1
            continue

        # Page marker.
        if _PAGE_MARKER_RE.match(line):
            blocks.append(_Block("marker", 0, ls, le + 1))
            i += 1
            continue

        # Blank line: emit a blank block, useful for paragraph boundaries.
        if not line.strip():
            blocks.append(_Block("blank", 0, ls, le + 1))
            i += 1
            continue

        # Heading.
        m = _HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            blocks.append(_Block("heading", level, ls, le + 1))
            i += 1
            continue

        # Table: detected by a header line followed (within 1 line) by a
        # separator.  Otherwise a single `|` line is just paragraph text.
        if _TABLE_LINE_RE.match(line):
            sep_idx = i + 1
            is_table = (
                sep_idx < len(line_spans)
                and _TABLE_SEPARATOR_RE.match(line_spans[sep_idx][2]) is not None
            )
            if is_table:
                # Consume the contiguous table block (until blank or EOF).
                start = ls
                j = i
                while j < len(line_spans):
                    js, je, jl = line_spans[j]
                    if not jl.strip():
                        break
                    if not _TABLE_LINE_RE.match(jl):
                        break
                    j += 1
                end = line_spans[j - 1][1] + 1
                blocks.append(_Block("table", 0, start, end))
                i = j
                continue

        # List group: contiguous list items + their nested-indent
        # continuations, terminated by a blank line or a non-indented
        # non-list line.
        if _LIST_ITEM_RE.match(line):
            start = ls
            j = i
            while j < len(line_spans):
                js, je, jl = line_spans[j]
                if not jl.strip():
                    break
                # Continuation: list item OR indented (>=2 spaces) line.
                if _LIST_ITEM_RE.match(jl) or jl.startswith(("  ", "\t")):
                    j += 1
                    continue
                break
            end = line_spans[j - 1][1] + 1
            blocks.append(_Block("list", 0, start, end))
            i = j
            continue

        # Plain paragraph: consume contiguous non-empty non-special lines.
        start = ls
        j = i
        while j < len(line_spans):
            js, je, jl = line_spans[j]
            if not jl.strip():
                break
            if (
                _HEADING_RE.match(jl)
                or _PAGE_MARKER_RE.match(jl)
                or (_CODE_FENCE_RE.match(jl) and j in paired_fences)
                or _LIST_ITEM_RE.match(jl)
                or (_TABLE_LINE_RE.match(jl) and _has_table_separator_after(line_spans, j))
            ):
                break
            j += 1
        end = line_spans[j - 1][1] + 1
        if paragraph_max_chars is not None and end - start > paragraph_max_chars:
            for sub_start, sub_end in _subsplit_paragraph_offsets(
                md, start, end, paragraph_max_chars,
            ):
                blocks.append(_Block("paragraph", 0, sub_start, sub_end))
        else:
            blocks.append(_Block("paragraph", 0, start, end))
        i = j

    # Unclosed code fence: a stray ``` with no matching closer would otherwise
    # leave every following line consumed but unrepresented as a block, which
    # makes ``pieces`` no longer cover ``md`` end-to-end and silently drops
    # content from the reassembled output.  Treat the unfinished fence as a
    # single code block running to EOF — the reassembly invariant matters
    # more than the structural purity of the resulting piece.
    if in_fence and fence_block_start >= 0:
        blocks.append(_Block("code", 0, fence_block_start, len(md)))

    # Clamp the last block's end to len(md) to handle the no-trailing-newline case.
    if blocks:
        last = blocks[-1]
        if last.end > len(md):
            blocks[-1] = _Block(last.kind, last.heading_level, last.start, len(md))
    return blocks


def _has_table_separator_after(line_spans: list[tuple[int, int, str]], i: int) -> bool:
    """Helper used by the paragraph scanner to peek for a table separator."""
    return i + 1 < len(line_spans) and _TABLE_SEPARATOR_RE.match(line_spans[i + 1][2]) is not None


# ---------------------------------------------------------------------------
# Split-point selection
# ---------------------------------------------------------------------------

def _pick_split_points(
    blocks: list[_Block],
    target_chars: int,
    max_chars: int,
) -> list[int]:
    """Choose block indices at which to emit a piece boundary.

    Returns a list of block indices ``b`` meaning "piece ends just before
    block b".  The list is strictly increasing and always ends with
    ``len(blocks)``.  An empty input returns ``[]``.

    Strategy (single linear pass, no inner search):

        Walk the blocks tracking the highest-priority boundary seen since
        the last split (the "best so far").  Boundary priority is:

            4 — heading            (semantic break, strongly preferred)
            3 — blank line         (paragraph break)
            2 — page marker        (page boundary inside the source)
            0 — anything else      (not considered a boundary)

        On each block, after accumulating its size into ``running``:

          * If ``running >= target_chars`` and a *heading* boundary is
            available, split there.  This is the "ideal" case: pieces
            are semantically coherent.

          * Otherwise if ``running >= max_chars``, force a split at the
            best non-heading boundary seen so far (blank or marker), or
            — if there's no boundary at all — after the current block.
            Forced splits never land inside a structural block because
            blocks are atomic; the cut is always between blocks.

        ``running >= target_chars`` without a heading available and
        below ``max_chars`` keeps accumulating.  That lets the splitter
        wait for a clean section boundary instead of cutting in the
        middle of a list or table-adjacent region.

    Compared with the previous score-based implementation this version
    cannot accidentally penalise every candidate below the initial
    threshold (which left documents with huge contiguous regions stuck
    as a single piece — see the regression test in markdown_splitter
    tests).
    """
    if not blocks:
        return []

    def _block_size(b: _Block) -> int:
        return b.end - b.start

    split_points: list[int] = []
    start = 0                   # block index at which the current piece begins
    running = 0
    # Track the *most recent* heading and the *most recent* secondary
    # boundary (blank / marker) separately.  Splitting at the LATEST
    # heading produces the most balanced pieces — anchoring at the FIRST
    # heading would close the piece almost immediately every time a
    # section header comes early in the next slice.  Secondary boundaries
    # are reserved for the forced-split fallback when no heading is
    # available before max_chars is hit.
    last_heading_idx = -1
    last_secondary_idx = -1

    def _reset_after_split(split_idx: int, current_i: int) -> None:
        """Roll state forward after committing a split at ``split_idx``.

        ``split_idx`` becomes the start of the next piece.  ``running``
        is set to the size of the blocks already inside that next piece
        (from ``split_idx`` to ``current_i`` inclusive, since those have
        already been visited by the outer loop).
        """
        nonlocal start, running, last_heading_idx, last_secondary_idx
        start = split_idx
        running = sum(_block_size(blocks[k]) for k in range(split_idx, current_i + 1))
        last_heading_idx = -1
        last_secondary_idx = -1

    for i, block in enumerate(blocks):
        # Track candidate boundaries.  Only positions strictly after the
        # current piece's start are valid candidates: a piece that
        # starts at a heading must not immediately split there again.
        if i > start:
            if block.kind == "heading":
                last_heading_idx = i
            elif block.kind in ("blank", "marker"):
                last_secondary_idx = i

        running += _block_size(block)

        # Ideal split: at or above the soft target AND we've passed a
        # heading since the last split.
        if running >= target_chars and last_heading_idx > start:
            split_points.append(last_heading_idx)
            _reset_after_split(last_heading_idx, i)
            continue

        # Forced split: piece is over the hard cap.  Defer when a
        # heading sits within a few blocks ahead — letting the heading
        # boundary fire on the next iteration produces semantically
        # cleaner pieces and avoids the "split at blank, then split at
        # the immediately-following heading → 1-char piece" pathology
        # the previous design hit.
        if running >= max_chars:
            upcoming_heading_close = any(
                blocks[j].kind == "heading"
                for j in range(i + 1, min(len(blocks), i + 4))
            )
            if upcoming_heading_close:
                continue

            # Use the secondary boundary (blank/marker) when available;
            # otherwise force a split between the current block and the
            # next.  The cut is still always between blocks, so we
            # never break a table, code fence, or list mid-structure.
            if last_secondary_idx > start:
                split_points.append(last_secondary_idx)
                _reset_after_split(last_secondary_idx, i)
            else:
                split_idx = i + 1
                if split_idx < len(blocks):
                    split_points.append(split_idx)
                    start = split_idx
                    running = 0
                    last_heading_idx = -1
                    last_secondary_idx = -1
                # else: this was the last block; the trailing append
                # below finalises the document.
            continue

    if not split_points or split_points[-1] != len(blocks):
        split_points.append(len(blocks))
    return split_points


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def split_markdown(
    md: str,
    *,
    target_chars: int = 4000,
    max_chars: int = 8000,
) -> list[Piece]:
    """Split *md* into structure-aware pieces.

    Args:
        md:           Source markdown to split.  Must already be UTF-8
                      decoded.  Empty input returns an empty list.
        target_chars: Soft size goal per piece.  The splitter aims for
                      pieces in the range ``[0.4 * target, target]`` whenever
                      a structural boundary is available there.
        max_chars:    Hard upper bound.  If no acceptable boundary exists
                      below this size, a split is forced at the next block
                      boundary regardless of preference.  Set well above
                      target_chars to leave room for the splitter to find
                      good cuts.

    Returns:
        A list of :class:`Piece` objects covering the entire input in
        order.  Concatenating ``piece.content`` for every piece reproduces
        the source exactly.
    """
    if not md:
        return []
    if target_chars <= 0 or max_chars < target_chars:
        raise ValueError("target_chars must be > 0 and <= max_chars")

    blocks = _classify_blocks(md, paragraph_max_chars=target_chars)
    if not blocks:
        return [Piece(index=0, content=md, start=0, end=len(md))]

    split_indices = _pick_split_points(blocks, target_chars, max_chars)
    pieces: list[Piece] = []
    prev_block = 0
    for idx, end_block in enumerate(split_indices):
        first = blocks[prev_block]
        last = blocks[end_block - 1]
        start = first.start
        end = last.end
        pieces.append(Piece(
            index=idx,
            content=md[start:end],
            start=start,
            end=end,
        ))
        prev_block = end_block

    return pieces


# ---------------------------------------------------------------------------
# Rolling context helper
# ---------------------------------------------------------------------------

def rolling_context(
    md: str,
    piece: Piece,
    *,
    context_chars: int = 800,
) -> str:
    """Return the last ``context_chars`` characters of the *original* text
    immediately preceding *piece*.

    Pulled from ``md`` (the source the splitter ran on), NEVER from a
    corrected piece — that's the key invariant that prevents drift.
    Returns an empty string for the first piece.

    The returned snippet is trimmed at a paragraph boundary if one exists
    within the window, so the LLM doesn't get a context fragment that
    starts mid-sentence (which would itself read as a "broken" piece worth
    fixing).
    """
    if piece.start <= 0 or context_chars <= 0:
        return ""
    raw_start = max(0, piece.start - context_chars)
    snippet = md[raw_start:piece.start]
    # Prefer to start at the first paragraph boundary inside the window —
    # cleaner context for the LLM.
    nl_idx = snippet.find("\n\n")
    if nl_idx != -1 and nl_idx < context_chars // 2:
        snippet = snippet[nl_idx + 2:]
    return snippet
