"""
Text splitters backed by LangChain text-splitters.

Supports four strategies: ``token``, ``recursive``, ``character``, ``markdown``.

Install:
    pip install langchain-text-splitters tiktoken

# TODO (PERF): All LangChain split_text() strategies are pure-Python string
# processing that holds the GIL for their entire duration.  The current
# ThreadPoolExecutor (via asyncio.to_thread()) therefore provides no
# parallelism when 2+ chunking requests run simultaneously — the threads
# serialise on the GIL and effective throughput is no better than serial.
# If profiling under real load confirms GIL contention, replace
# asyncio.to_thread() in chunks_router.py with a ProcessPoolExecutor worker
# for this splitter.  The trade-off is pickling overhead (~few ms) vs. true
# CPU parallelism.  Only worth doing if concurrent chunking is a bottleneck.
"""

from __future__ import annotations

from typing import Callable

from fastapi import HTTPException
from langchain_text_splitters import (
    CharacterTextSplitter,
    Language,
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
    TokenTextSplitter,
)

from backend.models.schemas import ChunkItem, ChunkRequest, SplitterType
from backend.registry import register_splitter
from .base import TextSplitter

# Headers recognised by the Markdown splitter (H1 → H3).
_MARKDOWN_HEADERS = [
    ("#", "Header 1"),
    ("##", "Header 2"),
    ("###", "Header 3"),
]

_LIB = "langchain"
_LIB_LABEL = "LangChain"


class LangChainSplitter(TextSplitter):
    """Text splitter that delegates to LangChain's text-splitting utilities.

    Strategy is chosen at call time via :attr:`ChunkRequest.splitter_type`.

    Strategies
    ----------
    token
        :class:`~langchain_text_splitters.TokenTextSplitter` — splits on token
        boundaries using tiktoken; ideal for LLM context-window management.
    recursive
        :class:`~langchain_text_splitters.RecursiveCharacterTextSplitter` —
        tries paragraph, sentence, word boundaries in order.
    character
        :class:`~langchain_text_splitters.CharacterTextSplitter` — splits on
        ``\\n\\n`` paragraphs, then falls back to ``chunk_size`` characters.
    markdown
        Two-phase split: headers via
        :class:`~langchain_text_splitters.MarkdownHeaderTextSplitter`, then
        optional size cap via
        :class:`~langchain_text_splitters.RecursiveCharacterTextSplitter`
        (activated by ``enable_markdown_sizing``).
    """

    def split(self, request: ChunkRequest) -> list[ChunkItem]:
        handler = self._DISPATCH.get(request.splitter_type)
        if handler is None:
            raise HTTPException(
                status_code=400,
                detail=f"LangChainSplitter does not support splitter_type='{request.splitter_type}'",
            )
        return handler(self, request)

    # ------------------------------------------------------------------
    # Private strategy methods
    # ------------------------------------------------------------------

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="token", label="Token",
        description="Splits on token boundaries via tiktoken. Ideal for LLM context-window management.",
    )
    def _split_token(self, request: ChunkRequest) -> list[ChunkItem]:
        splitter = TokenTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        splits = splitter.split_text(request.content)
        # chunk_overlap is in *tokens*; build_chunks needs *characters*.
        # Measure the actual character overlap from the first adjacent pair
        # rather than estimating a token→char ratio.
        char_overlap = self.measure_char_overlap(splits)
        return self.build_chunks(request.content, splits, char_overlap)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="recursive", label="Recursive",
        description="Tries paragraph → sentence → word boundaries in order.",
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

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="character", label="Character",
        description="Splits on \\n\\n paragraphs, falls back to chunk_size characters.",
    )
    def _split_character(self, request: ChunkRequest) -> list[ChunkItem]:
        splitter = CharacterTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            separator="\n\n",
        )
        return self.build_chunks(
            request.content,
            splitter.split_text(request.content),
            request.chunk_overlap,
        )

    @register_splitter(
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

        # MarkdownHeaderTextSplitter preserves header text in page_content
        # (strip_headers=False), so each page_content is a verbatim substring
        # of the original — build_chunks can locate real character offsets.
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

    _DISPATCH: dict[SplitterType, Callable[[LangChainSplitter, ChunkRequest], list[ChunkItem]]] = {
        SplitterType.token: _split_token,
        SplitterType.recursive: _split_recursive,
        SplitterType.character: _split_character,
        SplitterType.markdown: _split_markdown,
    }