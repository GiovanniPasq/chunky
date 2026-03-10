"""
Text chunking service — splits Markdown / plain text into overlapping chunks.
"""

from __future__ import annotations

from typing import Callable, Dict, List

from fastapi import HTTPException
from langchain_text_splitters import (
    CharacterTextSplitter,
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
    TokenTextSplitter,
)

from backend.models.schemas import ChunkItem, ChunkRequest, ChunkResponse, SplitterType

# Headers recognised by the Markdown splitter (H1 → H3).
_MARKDOWN_HEADERS = [
    ("#", "Header 1"),
    ("##", "Header 2"),
    ("###", "Header 3"),
]


class ChunkingService:
    """Splits text into chunks using a variety of LangChain splitters."""

    def chunk_text(self, request: ChunkRequest) -> ChunkResponse:
        """Dispatch to the correct split strategy and return a :class:`ChunkResponse`."""
        handler = self._DISPATCH.get(request.splitter_type)
        if handler is None:
            # Should never happen thanks to Pydantic enum validation, but be safe.
            raise HTTPException(
                status_code=400,
                detail=f"Unknown splitter type '{request.splitter_type}'",
            )

        chunks = handler(self, request)
        return ChunkResponse(
            chunks=chunks,
            total_chunks=len(chunks),
            splitter_type=request.splitter_type,
        )

    # ------------------------------------------------------------------
    # Split strategies
    # ------------------------------------------------------------------

    def _split_token(self, request: ChunkRequest) -> List[ChunkItem]:
        splitter = TokenTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        return self._build_chunks(
            request.content,
            splitter.split_text(request.content),
            request.chunk_overlap,
        )

    def _split_recursive(self, request: ChunkRequest) -> List[ChunkItem]:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            length_function=len,
        )
        return self._build_chunks(
            request.content,
            splitter.split_text(request.content),
            request.chunk_overlap,
        )

    def _split_character(self, request: ChunkRequest) -> List[ChunkItem]:
        splitter = CharacterTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            separator="\n\n",
        )
        return self._build_chunks(
            request.content,
            splitter.split_text(request.content),
            request.chunk_overlap,
        )

    def _split_markdown(self, request: ChunkRequest) -> List[ChunkItem]:
        """Two-phase Markdown splitting.

        Phase 1 — split on H1/H2/H3 headers via :class:`MarkdownHeaderTextSplitter`.
        Phase 2 (optional) — apply a secondary :class:`RecursiveCharacterTextSplitter`
        to cap each section at ``chunk_size`` characters when
        ``enable_markdown_sizing`` is *True*.
        """
        md_splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=_MARKDOWN_HEADERS,
            strip_headers=False,  # keep header text inside each chunk
        )
        docs = md_splitter.split_text(request.content)

        if request.enable_markdown_sizing:
            secondary = RecursiveCharacterTextSplitter(
                chunk_size=request.chunk_size,
                chunk_overlap=request.chunk_overlap,
            )
            docs = secondary.split_documents(docs)

        return [
            ChunkItem(
                index=i,
                content=doc.page_content,
                metadata=doc.metadata,
                start=0,
                end=0,
            )
            for i, doc in enumerate(docs)
        ]

    # ------------------------------------------------------------------
    # Dispatch table (avoids dynamic getattr on user input)
    # ------------------------------------------------------------------

    _DISPATCH: Dict[SplitterType, Callable[[ChunkingService, ChunkRequest], List[ChunkItem]]] = {
        SplitterType.token: _split_token,
        SplitterType.recursive: _split_recursive,
        SplitterType.character: _split_character,
        SplitterType.markdown: _split_markdown,
    }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_chunks(
        original: str,
        splits: List[str],
        overlap: int,
    ) -> List[ChunkItem]:
        """Map raw text splits back to their character positions in *original*."""
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