from typing import List, Dict, Any
from fastapi import HTTPException

from langchain_text_splitters import (
    RecursiveCharacterTextSplitter,
    CharacterTextSplitter,
    MarkdownHeaderTextSplitter,
    TokenTextSplitter,
)

from backend.models.schemas import ChunkRequest, ChunkResponse, ChunkItem

SUPPORTED_SPLITTERS = {"token", "recursive", "character", "markdown"}

MARKDOWN_HEADERS = [
    ("#", "Header 1"),
    ("##", "Header 2"),
    ("###", "Header 3"),
]


class ChunkingService:

    def chunk_text(self, request: ChunkRequest) -> ChunkResponse:
        if request.splitter_type not in SUPPORTED_SPLITTERS:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid splitter type '{request.splitter_type}'. "
                       f"Valid options: {sorted(SUPPORTED_SPLITTERS)}",
            )

        handler = getattr(self, f"_split_{request.splitter_type}")
        chunks = handler(request)

        return ChunkResponse(
            chunks=chunks,
            total_chunks=len(chunks),
            splitter_type=request.splitter_type,
        )

    # ------------------------------------------------------------------
    # Private split strategies
    # ------------------------------------------------------------------

    def _split_token(self, request: ChunkRequest) -> List[ChunkItem]:
        splitter = TokenTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        return self._build_chunks(request.content, splitter.split_text(request.content), request.chunk_overlap)

    def _split_recursive(self, request: ChunkRequest) -> List[ChunkItem]:
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            length_function=len,
        )
        return self._build_chunks(request.content, splitter.split_text(request.content), request.chunk_overlap)

    def _split_character(self, request: ChunkRequest) -> List[ChunkItem]:
        splitter = CharacterTextSplitter(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            separator="\n\n",
        )
        return self._build_chunks(request.content, splitter.split_text(request.content), request.chunk_overlap)

    def _split_markdown(self, request: ChunkRequest) -> List[ChunkItem]:
        """
        Two-phase markdown splitting:
          1. Split on headers (H1 / H2 / H3) via MarkdownHeaderTextSplitter.
          2. Optionally apply a secondary RecursiveCharacterTextSplitter when
             `enable_markdown_sizing` is True, to cap each section at chunk_size.
        """
        md_splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=MARKDOWN_HEADERS,
            strip_headers=False,   # preserve header text inside each chunk
        )
        header_docs = md_splitter.split_text(request.content)

        if request.enable_markdown_sizing:
            secondary = RecursiveCharacterTextSplitter(
                chunk_size=request.chunk_size,
                chunk_overlap=request.chunk_overlap,
            )
            docs = secondary.split_documents(header_docs)
        else:
            docs = header_docs

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
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_chunks(
        original: str,
        splits: List[str],
        overlap: int,
    ) -> List[ChunkItem]:
        """Map raw text splits back to their positions in the original string."""
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
