"""
Chunk surrounding-context helpers.

Chunk enrichment receives ``start`` / ``end`` offsets from the splitter.  This
module turns those offsets back into a small, read-only window from the source
markdown so the LLM can understand where the selected chunk sits without being
asked to enrich neighboring content.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ChunkSurroundingContext:
    """Read-only markdown around a chunk."""

    before: str = ""
    after: str = ""

    def is_empty(self) -> bool:
        return not (self.before or self.after)

    def to_prompt_block(self) -> str:
        parts: list[str] = []
        if self.before:
            parts.append("BEFORE:\n" + self.before)
        if self.after:
            parts.append("AFTER:\n" + self.after)
        return "\n\n".join(parts)


def build_chunk_surrounding_context(
    markdown: str,
    *,
    content: str,
    start: int,
    end: int,
    before_chars: int,
    after_chars: int,
) -> ChunkSurroundingContext:
    """Return paragraph-trimmed markdown before and after a chunk.

    Offsets are trusted only when they still match the chunk content.  If they
    are stale or missing, the helper tries an exact content lookup.  When
    neither path is possible, it returns an empty context instead of attaching
    unrelated surrounding text.
    """

    resolved = _resolve_offsets(markdown, content=content, start=start, end=end)
    if resolved is None:
        return ChunkSurroundingContext()

    resolved_start, resolved_end = resolved
    before = _trim_before(markdown[max(0, resolved_start - max(before_chars, 0)):resolved_start])
    after = _trim_after(markdown[resolved_end:resolved_end + max(after_chars, 0)])
    return ChunkSurroundingContext(before=before, after=after)


def _resolve_offsets(
    markdown: str,
    *,
    content: str,
    start: int,
    end: int,
) -> tuple[int, int] | None:
    if not markdown:
        return None

    if _valid_range(markdown, start, end) and _range_matches(markdown[start:end], content):
        return start, end

    if content:
        located = markdown.find(content)
        if located != -1:
            return located, located + len(content)

    return None


def _valid_range(markdown: str, start: int, end: int) -> bool:
    return 0 <= start <= end <= len(markdown)


def _range_matches(candidate: str, content: str) -> bool:
    if not content.strip():
        return True
    candidate_norm = " ".join(candidate.split())
    content_norm = " ".join(content.split())
    if not candidate_norm:
        return False
    if candidate_norm == content_norm:
        return True
    return content_norm in candidate_norm or candidate_norm in content_norm


def _trim_before(snippet: str) -> str:
    snippet = snippet.strip()
    if not snippet:
        return ""
    boundary = snippet.rfind("\n\n")
    if boundary >= len(snippet) // 4:
        snippet = snippet[boundary + 2:]
    return snippet.strip()


def _trim_after(snippet: str) -> str:
    snippet = snippet.strip()
    if not snippet:
        return ""
    boundary = snippet.find("\n\n")
    if boundary != -1 and boundary <= len(snippet) * 3 // 4:
        snippet = snippet[:boundary]
    return snippet.strip()
