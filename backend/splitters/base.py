"""
Abstract base class for text splitters.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List

from backend.models.schemas import ChunkItem, ChunkRequest


class TextSplitter(ABC):
    """Base class for all text splitters.

    Subclasses must implement :meth:`split`. They receive the full
    :class:`~backend.models.schemas.ChunkRequest` so they can access
    ``chunk_size``, ``chunk_overlap``, ``splitter_type``,
    ``enable_markdown_sizing``, and any future fields without a signature change.
    """

    @abstractmethod
    def split(self, request: ChunkRequest) -> List[ChunkItem]:
        """Split the text in *request* and return a list of :class:`ChunkItem`.

        Args:
            request: The validated chunking request, including text content
                     and all splitting parameters.

        Returns:
            Ordered list of :class:`ChunkItem` objects with ``index``,
            ``content``, ``start``, ``end``, and optional ``metadata``.
        """

    # ------------------------------------------------------------------
    # Shared helpers available to all subclasses
    # ------------------------------------------------------------------

    @staticmethod
    def build_chunks(
        original: str,
        splits: List[str],
        overlap: int,
    ) -> List[ChunkItem]:
        """Map raw text splits back to their character positions in *original*.

        Args:
            original: The source text that was split.
            splits:   List of text fragments produced by the splitter.
            overlap:  Overlap size used during splitting (controls search window).

        Returns:
            :class:`ChunkItem` list with ``start`` / ``end`` positions filled in.
        """
        chunks: List[ChunkItem] = []
        search_start = 0

        for i, text in enumerate(splits):
            start = original.find(text, search_start)
            if start == -1:
                start = search_start
            end = start + len(text)
            chunks.append(ChunkItem(index=i, content=text, start=start, end=end))
            search_start = max(0, end - overlap)

        return chunks