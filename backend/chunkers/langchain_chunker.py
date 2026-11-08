"""
Text splitters backed by LangChain text-splitters.

Supports four strategies: ``token``, ``recursive``, ``character``, ``markdown``.

Install:
    pip install langchain-text-splitters tiktoken
"""

from __future__ import annotations

from typing import Callable

from fastapi import HTTPException
from langchain_text_splitters import (
    Language,
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)

from backend.models.schemas import ChunkItem, ChunkRequest, ChunkerType
from backend.registry import register_chunker
from .base import TextChunker
from .source_windows import token_windows

# Headers recognised by the Markdown splitter (H1 → H3).
_MARKDOWN_HEADERS = [
    ("#", "Header 1"),
    ("##", "Header 2"),
    ("###", "Header 3"),
]

_LIB = "langchain"
_LIB_LABEL = "LangChain"


class LangChainChunker(TextChunker):
    """Text splitter that delegates to LangChain's text-splitting utilities.

    Strategy is chosen at call time via :attr:`ChunkRequest.chunker_type`.

    Strategies
    ----------
    token
        GPT-2 windows through tiktoken, with complete Unicode characters and
        source offsets mapped directly from token boundaries.
    recursive
        :class:`~langchain_text_splitters.RecursiveCharacterTextSplitter` —
        tries Markdown structures, paragraphs, lines, and word boundaries.
    character
        Splits on ``\\n\\n`` paragraphs, then falls back to characters.
    markdown
        Two-phase split: headers via
        :class:`~langchain_text_splitters.MarkdownHeaderTextSplitter`, then
        optional size cap via
        :class:`~langchain_text_splitters.RecursiveCharacterTextSplitter`
        (activated by ``enable_markdown_sizing``).
    """

    def chunk(self, request: ChunkRequest) -> list[ChunkItem]:
        handler = self._DISPATCH.get(request.chunker_type)
        if handler is None:
            raise HTTPException(
                status_code=400,
                detail=f"LangChainChunker does not support chunker_type='{request.chunker_type}'",
            )
        return handler(self, request)

    # ------------------------------------------------------------------
    # Private strategy methods
    # ------------------------------------------------------------------

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="token", label="Token",
        description="GPT-2 token windows with Unicode-safe boundaries. Overlap may be smaller to keep characters intact.",
    )
    def _split_token(self, request: ChunkRequest) -> list[ChunkItem]:
        return token_windows(request.content, request.chunk_size, request.chunk_overlap)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="recursive", label="Recursive",
        description="Splits Markdown headings, code fences, paragraphs, lines, and words using a character target.",
    )
    def _split_recursive(self, request: ChunkRequest) -> list[ChunkItem]:
        # Use markdown-aware separators: headings, fences, horizontal rules,
        # blank lines, newlines — in that priority order.  chunk_size and
        # chunk_overlap are in characters (length_function=len is the default).
        splitter = RecursiveCharacterTextSplitter.from_language(
            Language.MARKDOWN,
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        return self.build_chunks(
            request.content,
            splitter.split_text(request.content),
            request.chunk_overlap,
        )

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="character", label="Character",
        description="Splits on \\n\\n paragraphs, falls back to chunk_size characters.",
    )
    def _split_character(self, request: ChunkRequest) -> list[ChunkItem]:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            separators=["\n\n", ""],
            keep_separator=False,
        )
        return self.build_chunks(
            request.content,
            splitter.split_text(request.content),
            request.chunk_overlap,
        )

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="markdown", label="Markdown",
        description=(
            "Two-phase split: H1/H2/H3 headers first, then optional size cap "
            "via RecursiveCharacterTextSplitter (enable_markdown_sizing)."
        ),
    )
    def _split_markdown(self, request: ChunkRequest) -> list[ChunkItem]:
        """Two-phase Markdown splitting.

        Phase 1 — split on H1/H2/H3 headers via
        :class:`~langchain_text_splitters.MarkdownHeaderTextSplitter`.

        Phase 2 (optional) — apply a secondary
        :class:`~langchain_text_splitters.RecursiveCharacterTextSplitter`
        to cap each section at ``chunk_size`` characters when
        ``enable_markdown_sizing`` is *True*.
        """
        md_splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=_MARKDOWN_HEADERS,
            strip_headers=False,
        )
        docs = md_splitter.split_text(request.content)

        if request.enable_markdown_sizing:
            # Use the same markdown-aware separators as the recursive strategy
            # so that sub-splits also respect markdown structure.
            secondary = RecursiveCharacterTextSplitter.from_language(
                Language.MARKDOWN,
                chunk_size=request.chunk_size,
                chunk_overlap=request.chunk_overlap,
            )
            docs = secondary.split_documents(docs)

        # Headers are retained, but the library normalizes whitespace;
        # build_chunks maps those normalized fragments back to the source.
        # Phase-1 splits have no overlap; phase-2 inherits request.chunk_overlap.
        char_overlap = request.chunk_overlap if request.enable_markdown_sizing else 0
        chunks = self.build_chunks(
            request.content,
            [doc.page_content for doc in docs],
            char_overlap,
        )
        # Preserve header metadata produced by MarkdownHeaderTextSplitter.
        for chunk, doc in zip(chunks, docs):
            chunk.metadata = doc.metadata
        return chunks

    # ------------------------------------------------------------------
    # Dispatch table
    # ------------------------------------------------------------------

    _DISPATCH: dict[ChunkerType, Callable[[LangChainChunker, ChunkRequest], list[ChunkItem]]] = {
        ChunkerType.token: _split_token,
        ChunkerType.recursive: _split_recursive,
        ChunkerType.character: _split_character,
        ChunkerType.markdown: _split_markdown,
    }
