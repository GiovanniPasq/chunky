"""
Abstract base class for text chunkers.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
import re

from backend.models.schemas import ChunkItem, ChunkRequest


class TextChunker(ABC):
    """Base class for all text chunkers.

    Subclasses must implement :meth:`chunk`. They receive the full
    :class:`~backend.models.schemas.ChunkRequest` so they can access
    ``chunk_size``, ``chunk_overlap``, ``chunker_type``,
    ``enable_markdown_sizing``, and any future fields without a signature change.
    """

    @abstractmethod
    def chunk(self, request: ChunkRequest) -> list[ChunkItem]:
        """Chunk the text in *request* and return a list of :class:`ChunkItem`.

        Args:
            request: The validated chunking request, including text content
                     and all chunking parameters.

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
        splits: list[str],
        char_overlap: int,
    ) -> list[ChunkItem]:
        """Map raw text splits back to their character positions in *original*.

        Args:
            original:     The source text that was chunked.
            splits:       List of text fragments produced by the chunker.
            char_overlap: Overlap size **in characters** used during chunking.
                          Controls how far back the search window rewinds before
                          looking for the next chunk. Token windows use their
                          native token-to-source mapping instead.

        Returns:
            :class:`ChunkItem` list with ``start`` / ``end`` positions filled in.
        """
        chunks: list[ChunkItem] = []
        search_start = 0

        for i, text in enumerate(splits):
            # Markdown splitters can normalize indentation and line breaks.
            # Match those whitespace changes against the source rather than
            # assigning a guessed cursor position to the resulting chunk.
            pattern = re.compile(''.join(
                r'\s+' if part.isspace() else re.escape(part)
                for part in re.split(r'(\s+)', text)
            ))
            match = pattern.search(original, search_start)
            if match:
                start = match.start()
                end = match.end()
                if original.startswith(text, start):
                    end = start + len(text)
                chunks.append(ChunkItem(index=i, content=text, start=start, end=end))
                search_start = min(len(original), max(start + 1, end - char_overlap))
            else:
                # Serializers can transform tables or aggregate non-contiguous
                # sections. Do not invent offsets that would attach unrelated
                # source text during highlighting or enrichment.
                chunks.append(ChunkItem(
                    index=i, content=text, start=0, end=0,
                    metadata={'source_span_available': False},
                ))

        return chunks
