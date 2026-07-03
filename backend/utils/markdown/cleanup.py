"""
Deterministic regex-based cleanup for converter output.

Runs as the first stage of the enrichment pipeline, fixing the ~80% of
markdown artifacts that don't need an LLM:

    * Standalone page numbers ("47", "Page 47 of 200", "- 47 -")
    * Repeated headers/footers across page-marker boundaries
    * Soft hyphens and a small set of common mojibake patterns
    * 3+ consecutive blank lines
    * Sentences broken mid-word by hyphenated line wraps
    * Heading-level jumps that skip a tier (H1 → H3)

Each transformation is a pure ``str -> str`` function with no side effects,
no I/O, and is *idempotent*: applying it twice produces the same output as
applying it once.  The orchestrator function :func:`clean_markdown` composes
them in a fixed order and returns both the cleaned text and a small report
summarising what changed, so callers can show a "12 page numbers stripped,
3 headers detected" hint in the UI without re-implementing the diff.

The LLM stage of the pipeline (see ``enrichment_service.enrich_piece``)
runs over the already-cleaned text, which lets its prompt focus on hard
cases (OCR errors, fractured sentences, semantic merges) and reject the
temptation to "fix" surface-level artifacts cosmetically.

Performance: every function processes the document in a single pass with
compiled regexes; total cleanup of a 400-page document is dominated by
header/footer detection (one pass per region) and stays sub-second.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Page-marker awareness
# ---------------------------------------------------------------------------
# Converters that emit per-page output (VLM, and any future page-aware one)
# inject ``<!-- page-marker:N -->`` comments between pages.  Several cleanup
# steps work *per page region* (e.g. detecting repeated headers/footers).
# We never strip the markers themselves — downstream tooling, the scroll-sync
# logic, and the failed-page banner all depend on them.
_PAGE_MARKER_RE = re.compile(r"<!--\s*page-marker:\d+\s*-->")
_FAILED_MARKER_RE = re.compile(r"<!--\s*page\s+\d+\s+failed:")

# ---------------------------------------------------------------------------
# Compiled patterns
# ---------------------------------------------------------------------------

# A "page number line" is a short line containing only a numeric (or
# numeric-with-decoration) token.  Conservative: we require the entire
# stripped line to match — this avoids gobbling list items or numeric
# headings.  Examples matched:
#   "47"
#   "- 47 -"
#   "Page 47"
#   "Page 47 of 200"
#   "47 / 200"
_DECORATED_PAGE_NUMBER_LINE_RE = re.compile(
    r"^\s*(?:-\s*\d+\s*-|Page\s+\d+(?:\s+of\s+\d+)?|\d+\s*/\s*\d+)\s*$",
    re.IGNORECASE,
)
_BARE_PAGE_NUMBER_LINE_RE = re.compile(r"^\s*\d{1,4}\s*$")

# Soft hyphens, zero-width spaces, BOMs — invisible characters that survive
# conversion and confuse both humans and tokenisers.
_INVISIBLE_CHARS_RE = re.compile(r"[­​‌‍﻿]")

# Common mojibake from UTF-8 mis-decoded as CP1252.  Restricted set — only
# patterns frequent enough to be unambiguous.  Anything more aggressive risks
# corrupting genuinely-encoded text.
_MOJIBAKE_FIXES = [
    ("â€™", "'"),     # right single quote
    ("â€œ", '"'),     # left double quote
    ("â€\x9d", '"'),  # right double quote
    ("â€“", "–"),     # en dash
    ("â€”", "—"),     # em dash
    ("â€¦", "…"),     # ellipsis
    ("Â ", " "),      # non-breaking space artefact
]

# Mid-word hyphenated line wrap: "...hyper-\nactive..." → "...hyperactive...".
# Only collapses when the next line starts with a lowercase letter, to avoid
# joining intentional hyphenation (e.g. proper nouns).
_HYPHEN_WRAP_RE = re.compile(r"(\w)-\n(?=[a-z])")

# Mid-sentence linebreak (no trailing punctuation, lowercase continuation).
# Only joins lines whose first word starts with a lowercase letter and where
# the previous line doesn't end in sentence-terminating punctuation.  Bullet
# items, headings, and code lines are skipped (see _join_split_sentences).
_SENTENCE_CONTINUATION_RE = re.compile(r"(?<![.!?:;])\n(?=[a-z])")

# Heading lines: leading hashes, capture the level.
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")

# Lines that are likely to BE the protected boundary of a structural block.
_TABLE_LINE_RE = re.compile(r"^\s*\|")
_CODE_FENCE_RE = re.compile(r"^\s*```")
_LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+]\s|\d+\.\s)")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class CleanupReport:
    """Summary of changes made by :func:`clean_markdown`.

    All counts are pre-aggregation: a single page-marker boundary stripped
    on every page-region counts as one stripped header line, not N.
    """

    page_numbers_stripped: int = 0
    repeated_headers_stripped: int = 0
    repeated_footers_stripped: int = 0
    blank_runs_collapsed: int = 0
    hyphen_wraps_joined: int = 0
    sentence_joins: int = 0
    soft_hyphens_removed: int = 0
    mojibake_fixed: int = 0
    heading_jumps_fixed: int = 0
    pages_seen: int = 0

    def total_changes(self) -> int:
        return (
            self.page_numbers_stripped
            + self.repeated_headers_stripped
            + self.repeated_footers_stripped
            + self.blank_runs_collapsed
            + self.hyphen_wraps_joined
            + self.sentence_joins
            + self.soft_hyphens_removed
            + self.mojibake_fixed
            + self.heading_jumps_fixed
        )

    def as_dict(self) -> dict:
        # Stable JSON shape for the SSE event / API response.
        return {
            "page_numbers_stripped": self.page_numbers_stripped,
            "repeated_headers_stripped": self.repeated_headers_stripped,
            "repeated_footers_stripped": self.repeated_footers_stripped,
            "blank_runs_collapsed": self.blank_runs_collapsed,
            "hyphen_wraps_joined": self.hyphen_wraps_joined,
            "sentence_joins": self.sentence_joins,
            "soft_hyphens_removed": self.soft_hyphens_removed,
            "mojibake_fixed": self.mojibake_fixed,
            "heading_jumps_fixed": self.heading_jumps_fixed,
            "pages_seen": self.pages_seen,
            "total_changes": self.total_changes(),
        }


# ---------------------------------------------------------------------------
# Page-region helpers
# ---------------------------------------------------------------------------

def _split_into_page_regions(md: str) -> list[str]:
    """Split *md* on page-marker comments, keeping the markers attached to
    the region they precede.

    Returns the original document if no markers are present (treated as a
    single region).  Used by header/footer detection so we only flag a
    line as a "repeated header" if it appears at the top of multiple page
    regions, not just multiple times anywhere in the document.
    """
    parts = _PAGE_MARKER_RE.split(md)
    if len(parts) <= 1:
        return [md]
    markers = _PAGE_MARKER_RE.findall(md)
    # parts[0] is content before the first marker (often empty).
    regions: list[str] = []
    if parts[0].strip():
        regions.append(parts[0])
    for marker, body in zip(markers, parts[1:]):
        regions.append(f"{marker}{body}")
    return regions


def _join_page_regions(regions: list[str]) -> str:
    """Inverse of :func:`_split_into_page_regions`."""
    return "".join(regions)


# ---------------------------------------------------------------------------
# Individual cleanup steps
# ---------------------------------------------------------------------------

def _transform_outside_fences(md: str, transform) -> tuple[str, int]:
    """Apply a text transform only outside fenced code blocks."""
    output: list[str] = []
    buffer: list[str] = []
    count = 0
    in_fence = False

    def _flush() -> None:
        nonlocal count
        if not buffer:
            return
        transformed, changed = transform("".join(buffer))
        output.append(transformed)
        count += changed
        buffer.clear()

    for line in md.splitlines(keepends=True):
        if _CODE_FENCE_RE.match(line):
            _flush()
            output.append(line)
            in_fence = not in_fence
        elif in_fence:
            output.append(line)
        else:
            buffer.append(line)

    _flush()
    return "".join(output), count


def _strip_invisible_chars(md: str, report: CleanupReport) -> str:
    """Remove invisible conversion artefacts outside fenced code."""
    new_md, count = _transform_outside_fences(
        md,
        lambda text: _INVISIBLE_CHARS_RE.subn("", text),
    )
    report.soft_hyphens_removed += count
    return new_md


def _fix_mojibake(md: str, report: CleanupReport) -> str:
    """Apply unambiguous UTF-8-as-CP1252 fixes outside fenced code."""
    def _replace(text: str) -> tuple[str, int]:
        changed = 0
        for bad, good in _MOJIBAKE_FIXES:
            if bad in text:
                changed += text.count(bad)
                text = text.replace(bad, good)
        return text, changed

    md, count = _transform_outside_fences(md, _replace)
    report.mojibake_fixed += count
    return md


def _join_hyphen_wraps(md: str, report: CleanupReport) -> str:
    """Join prose hyphen wraps without modifying fenced code."""
    new_md, count = _transform_outside_fences(
        md,
        lambda text: _HYPHEN_WRAP_RE.subn(r"\1", text),
    )
    report.hyphen_wraps_joined += count
    return new_md


def _strip_page_numbers(md: str, report: CleanupReport) -> str:
    """Remove standalone page-number lines.

    Decorated labels are removed outside code. Bare integers are ambiguous,
    so they are removed only at a page-region edge when page markers exist.
    """
    stripped = 0
    has_page_markers = _PAGE_MARKER_RE.search(md) is not None
    new_regions: list[str] = []
    for region in _split_into_page_regions(md):
        lines = region.split("\n")
        eligible: list[int] = []
        in_fence = False
        for i, line in enumerate(lines):
            if _CODE_FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            value = line.strip()
            if (
                in_fence
                or not value
                or _PAGE_MARKER_RE.fullmatch(value)
                or _FAILED_MARKER_RE.match(value)
            ):
                continue
            eligible.append(i)

        edge_indices = {eligible[0], eligible[-1]} if eligible else set()
        for i in eligible:
            line = lines[i]
            if _DECORATED_PAGE_NUMBER_LINE_RE.match(line):
                lines[i] = ""
                stripped += 1
            elif (
                has_page_markers
                and i in edge_indices
                and _BARE_PAGE_NUMBER_LINE_RE.match(line)
            ):
                lines[i] = ""
                stripped += 1
        new_regions.append("\n".join(lines))

    report.page_numbers_stripped += stripped
    return _join_page_regions(new_regions)


def _strip_repeated_headers_footers(md: str, report: CleanupReport) -> str:
    """Detect and remove lines that repeat as the head/tail of many pages.

    Only fires when page markers are present (otherwise we have no notion
    of "page" to detect repetition against).  The detection threshold is
    ``>= max(2, ceil(0.6 * pages))`` matching pages — repetition must be
    pervasive, not occasional, to avoid stripping legitimate text.

    Considers the first non-empty non-marker line of each region as a
    candidate header, and the last as a candidate footer.  Failed-page
    placeholder comments are ignored so a partial conversion can't
    accidentally suppress the failure marker.
    """
    regions = _split_into_page_regions(md)
    report.pages_seen = max(report.pages_seen, len(regions))
    if len(regions) < 3:
        return md

    def _candidate_lines(region: str) -> tuple[str | None, str | None]:
        lines = region.split("\n")
        candidates: list[str] = []
        in_fence = False
        for line in lines:
            if _CODE_FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            stripped = line.strip()
            if (
                in_fence
                or not stripped
                or _PAGE_MARKER_RE.fullmatch(stripped)
                or _FAILED_MARKER_RE.match(stripped)
            ):
                continue
            candidates.append(stripped)
        return (
            candidates[0] if candidates else None,
            candidates[-1] if candidates else None,
        )

    heads: list[str | None] = []
    tails: list[str | None] = []
    for region in regions:
        h, t = _candidate_lines(region)
        heads.append(h)
        tails.append(t)

    threshold = max(2, (len(regions) * 6 + 9) // 10)
    head_counts = Counter(h for h in heads if h)
    tail_counts = Counter(t for t in tails if t)
    repeated_heads = {line for line, n in head_counts.items() if n >= threshold}
    repeated_tails = {line for line, n in tail_counts.items() if n >= threshold}

    if not repeated_heads and not repeated_tails:
        return md

    new_regions: list[str] = []
    stripped_head_total = 0
    stripped_foot_total = 0
    for region in regions:
        lines = region.split("\n")
        in_fence = False
        # Strip first repeating head (one occurrence per region).
        for i, line in enumerate(lines):
            if _CODE_FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            stripped = line.strip()
            if (
                in_fence
                or not stripped
                or _PAGE_MARKER_RE.fullmatch(stripped)
                or _FAILED_MARKER_RE.match(stripped)
            ):
                continue
            if stripped in repeated_heads:
                lines[i] = ""
                stripped_head_total += 1
            break
        # Strip last repeating tail.
        candidates: list[int] = []
        in_fence = False
        for i, line in enumerate(lines):
            if _CODE_FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            stripped = line.strip()
            if (
                in_fence
                or not stripped
                or _PAGE_MARKER_RE.fullmatch(stripped)
                or _FAILED_MARKER_RE.match(stripped)
            ):
                continue
            candidates.append(i)
        if candidates:
            i = candidates[-1]
            if lines[i].strip() in repeated_tails:
                lines[i] = ""
                stripped_foot_total += 1
        new_regions.append("\n".join(lines))

    report.repeated_headers_stripped += stripped_head_total
    report.repeated_footers_stripped += stripped_foot_total
    return _join_page_regions(new_regions)


def _join_split_sentences(md: str, report: CleanupReport) -> str:
    """Join lines that break a sentence mid-stream.

    A line is considered "continuation" only when:
      * the previous line doesn't end in ``.``, ``!``, ``?``, ``:``, ``;``
      * the next line starts with a lowercase ASCII letter
      * neither line is a table row, code fence, list item, or heading

    Code blocks and tables are tracked across the loop so we never touch
    line breaks inside them.  This keeps the rule conservative enough to
    avoid mangling legitimate prose-with-low-prose-conventions.
    """
    lines = md.split("\n")
    out_lines: list[str] = []
    in_fence = False
    joined = 0

    for line in lines:
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            out_lines.append(line)
            continue
        if in_fence or not out_lines:
            out_lines.append(line)
            continue

        prev = out_lines[-1]
        prev_stripped = prev.rstrip()
        cur_stripped = line.strip()

        skip = (
            not prev_stripped
            or not cur_stripped
            or _TABLE_LINE_RE.match(line)
            or _TABLE_LINE_RE.match(prev_stripped)
            or _LIST_ITEM_RE.match(line)
            or _LIST_ITEM_RE.match(prev_stripped)
            or _HEADING_RE.match(line)
            or _HEADING_RE.match(prev_stripped)
            or _PAGE_MARKER_RE.fullmatch(cur_stripped)
            or _PAGE_MARKER_RE.fullmatch(prev_stripped)
        )
        if skip:
            out_lines.append(line)
            continue

        last_char = prev_stripped[-1]
        first_char = cur_stripped[0]
        if last_char not in ".!?:;,)\"'”’]>" and "a" <= first_char <= "z":
            out_lines[-1] = f"{prev_stripped} {cur_stripped}"
            joined += 1
            continue

        out_lines.append(line)

    report.sentence_joins += joined
    return "\n".join(out_lines)


def _collapse_blank_runs(md: str, report: CleanupReport) -> str:
    """Collapse prose blank runs without modifying fenced code."""
    new_md, count = _transform_outside_fences(
        md,
        lambda text: re.subn(r"\n{3,}", "\n\n", text),
    )
    report.blank_runs_collapsed += count
    return new_md


def _normalise_heading_hierarchy(md: str, report: CleanupReport) -> str:
    """Fix heading-level jumps that skip a tier (e.g. H1 → H3).

    Demotes the deeper heading to one level below the previous heading.
    Conservative — only acts on jumps of *more than one* level, leaving
    H1 → H2, H2 → H3, etc. untouched.  Reset on H1 boundaries so unrelated
    documents pasted together don't bleed levels into each other.
    """
    lines = md.split("\n")
    last_level = 0
    fixed = 0
    in_fence = False
    for i, line in enumerate(lines):
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADING_RE.match(line)
        if not m:
            continue
        level = len(m.group(1))
        if last_level == 0 or level <= last_level + 1:
            last_level = level
            continue
        # Jump detected: bring down to last_level + 1.
        new_level = last_level + 1
        lines[i] = "#" * new_level + " " + m.group(2)
        fixed += 1
        last_level = new_level
    report.heading_jumps_fixed += fixed
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Top-level orchestrator
# ---------------------------------------------------------------------------

# Order matters: invisibles before sentence joins (joins inspect line tails),
# mojibake before hyphen wraps (mojibake produces stray characters that
# could confuse the hyphen rule), page numbers before header/footer detection
# (otherwise "Page N" lines pollute the head/tail candidates), and blank
# collapse last so the previous steps can leave intermediate blanks behind.
_CLEANUP_PIPELINE: list = [
    _strip_invisible_chars,
    _fix_mojibake,
    _join_hyphen_wraps,
    _strip_page_numbers,
    _strip_repeated_headers_footers,
    _join_split_sentences,
    _normalise_heading_hierarchy,
    _collapse_blank_runs,
]


def clean_markdown(md: str) -> tuple[str, CleanupReport]:
    """Run every deterministic cleanup step in the canonical order.

    Returns the cleaned text and a :class:`CleanupReport` summarising
    what was changed.  The function is pure: same input always produces
    the same output, no I/O, no global state, no logging side effects.
    Apply it twice and the second pass should be a no-op (idempotency
    is verified in the test suite).
    """
    report = CleanupReport()
    for step in _CLEANUP_PIPELINE:
        md = step(md, report)
    return md, report
