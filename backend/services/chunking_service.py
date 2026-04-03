"""
Text chunking service — dispatches to the appropriate splitter library.

The service instantiates either a :class:`~backend.splitters.LangChainSplitter`
or a :class:`~backend.splitters.ChonkieSplitter` based on
:attr:`~backend.models.schemas.ChunkRequest.splitter_library`, then delegates
the actual splitting to the chosen implementation.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)

from backend.models.schemas import ChunkRequest, ChunkResponse, SplitterLibrary
from backend.splitters import ChonkieSplitter, LangChainSplitter, TextSplitter

# Registry mapping enum values to splitter classes.
_LIBRARY_MAP: dict[SplitterLibrary, type[TextSplitter]] = {
    SplitterLibrary.langchain: LangChainSplitter,
    SplitterLibrary.chonkie: ChonkieSplitter,
}


class ChunkingService:
    """Orchestrates text splitting by selecting the correct splitter library.

    The splitting *strategy* (token, recursive, character, markdown) and
    *library* (langchain, chonkie) are both specified on the request, giving
    callers full control over the chunking pipeline.

    Splitter instances are created once and reused across calls — both
    LangChainSplitter and ChonkieSplitter are stateless (all splitting
    parameters come from the request, not from instance state).
    """

    def __init__(self) -> None:
        self._splitters: dict[SplitterLibrary, TextSplitter] = {
            lib: cls() for lib, cls in _LIBRARY_MAP.items()
        }

    def chunk_text(self, request: ChunkRequest) -> ChunkResponse:
        """Split text and return a :class:`ChunkResponse`.

        Args:
            request: Validated chunking parameters including content, strategy,
                     library selection, chunk size, and overlap.

        Returns:
            A :class:`ChunkResponse` containing all chunks plus summary metadata.

        Raises:
            HTTPException 400: If the requested library is not registered.
        """
        splitter = self._splitters.get(request.splitter_library)
        if splitter is None:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown splitter library '{request.splitter_library}'",
            )
        chunks = splitter.split(request)

        avg_chars = int(sum(len(c.content) for c in chunks) / len(chunks)) if chunks else 0
        logger.info(
            "Chunking complete: library=%s strategy=%s chunk_size=%d chunk_overlap=%d "
            "chunks=%d avg_chunk_chars=%d",
            request.splitter_library, request.splitter_type,
            request.chunk_size, request.chunk_overlap,
            len(chunks), avg_chars,
        )

        return ChunkResponse(
            chunks=chunks,
            total_chunks=len(chunks),
            splitter_type=request.splitter_type,
            splitter_library=request.splitter_library,
        )
