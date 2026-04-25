"""
Text splitter backed by Docling chunkers.

Applies document-structure-aware chunking on top of hierarchical document
parsing: headings, tables, lists, and captions are all respected as natural
split boundaries before any token-limit refinement is applied.

Install:
    pip install docling

Supported strategies
--------------------
    line_based → LineBasedTokenChunker (preserves line boundaries, token-aware)
    hybrid     → HybridChunker (document-structure + token-aware refinement)
"""

from __future__ import annotations

import io
from typing import Callable

from fastapi import HTTPException

from backend.models.schemas import ChunkItem, ChunkRequest, ChunkerType
from backend.registry import register_chunker
from .base import TextChunker

_LIB = "docling"
_LIB_LABEL = "Docling"


class DoclingChunker(TextChunker):
    """Text splitter delegating to Docling chunkers.

    DocumentConverter and AutoTokenizer are created once at instantiation time.
    ChunkingService holds a single DoclingSplitter instance, so the heavy
    initialisation cost is paid once at startup, not per request.
    """

    def __init__(self) -> None:
        from docling.document_converter import DocumentConverter
        from transformers import AutoTokenizer

        self._converter = DocumentConverter()
        self._auto_tokenizer = AutoTokenizer.from_pretrained(
            "sentence-transformers/all-MiniLM-L6-v2"
        )

    def chunk(self, request: ChunkRequest) -> list[ChunkItem]:
        handler = self._DISPATCH.get(request.chunker_type)
        if handler is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"DoclingChunker does not support "
                    f"chunker_type='{request.chunker_type}'"
                ),
            )
        return handler(self, request)

    # ------------------------------------------------------------------
    # Shared: build a HuggingFaceTokenizer wired to chunk_size
    # ------------------------------------------------------------------

    def _make_tokenizer(self, chunk_size: int):
        from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer

        return HuggingFaceTokenizer(
            tokenizer=self._auto_tokenizer,
            max_tokens=chunk_size,
        )

    # ------------------------------------------------------------------
    # Strategies
    # ------------------------------------------------------------------

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="line_based", label="Line-Based Token",
        description=(
            "Preserves line boundaries while respecting a token limit. "
            "Ideal for structured content like tables, code, or logs. "
            "chunk_size sets max_tokens per chunk."
        ),
    )
    def _split_line_based(self, request: ChunkRequest) -> list[ChunkItem]:
        from docling.datamodel.base_models import DocumentStream
        from docling_core.transforms.chunker.line_chunker import LineBasedTokenChunker

        chunker = LineBasedTokenChunker(tokenizer=self._make_tokenizer(request.chunk_size))

        stream = DocumentStream(
            name="content.md",
            stream=io.BytesIO(request.content.encode("utf-8")),
        )
        doc = self._converter.convert(source=stream).document
        raw_chunks = list(chunker.chunk(dl_doc=doc))
        return self._chunks_from_docling(chunker, raw_chunks, request.content)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="hybrid", label="Hybrid",
        description=(
            "Document-structure-aware chunking via Docling's HybridChunker. "
            "Respects headings, tables, and lists as natural split boundaries. "
            "chunk_size sets max_tokens per chunk."
        ),
    )
    def _split_hybrid(self, request: ChunkRequest) -> list[ChunkItem]:
        from docling.datamodel.base_models import DocumentStream
        from docling.chunking import HybridChunker

        chunker = HybridChunker(
            tokenizer=self._make_tokenizer(request.chunk_size),
            merge_peers=True,
        )

        stream = DocumentStream(
            name="content.md",
            stream=io.BytesIO(request.content.encode("utf-8")),
        )
        doc = self._converter.convert(source=stream).document
        raw_chunks = list(chunker.chunk(dl_doc=doc))
        return self._chunks_from_docling(chunker, raw_chunks, request.content)

    # ------------------------------------------------------------------
    # Shared helper
    # ------------------------------------------------------------------

    @staticmethod
    def _chunks_from_docling(chunker, raw_chunks, content: str) -> list[ChunkItem]:
        """Convert Docling BaseChunk objects to ChunkItem.

        item.content                  = chunk.text  (display)
        item.metadata["contextualized"] = contextualize() (embedding)
        """
        items = TextChunker.build_chunks(
            content,
            [c.text for c in raw_chunks],
            char_overlap=0,
        )
        for item, chunk in zip(items, raw_chunks):
            headings = getattr(getattr(chunk, "meta", None), "headings", None)
            if headings:
                item.metadata["headings"] = list(headings)
            item.metadata["contextualized"] = chunker.contextualize(chunk=chunk)
        return items

    # ------------------------------------------------------------------
    # Dispatch table
    # ------------------------------------------------------------------

    _DISPATCH: dict[ChunkerType, Callable[[DoclingChunker, ChunkRequest], list[ChunkItem]]] = {
        ChunkerType.line_based: _split_line_based,
        ChunkerType.hybrid: _split_hybrid,
    }
