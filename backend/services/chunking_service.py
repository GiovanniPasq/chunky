"""
Text chunking service — dispatches to the appropriate chunker library.

The service instantiates a :class:`~backend.chunkers.LangChainChunker`,
:class:`~backend.chunkers.ChonkieChunker`, or :class:`~backend.chunkers.DoclingChunker`
based on :attr:`~backend.models.schemas.ChunkRequest.chunker_library`, then delegates
the actual chunking to the chosen implementation.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)

from backend.models.schemas import ChunkRequest, ChunkResponse, SaveChunksRequest, ChunkerLibrary
from backend.chunkers import ChonkieChunker, DoclingChunker, LangChainChunker, TextChunker

# Registry mapping enum values to chunker classes.
_LIBRARY_MAP: dict[ChunkerLibrary, type[TextChunker]] = {
    ChunkerLibrary.langchain: LangChainChunker,
    ChunkerLibrary.chonkie: ChonkieChunker,
    ChunkerLibrary.docling: DoclingChunker,
}


class ChunkingService:
    """Orchestrates text chunking by selecting the correct chunker library.

    The chunking *strategy* (token, recursive, character, markdown, etc.) and
    *library* (langchain, chonkie, docling) are both specified on the request,
    giving callers full control over the chunking pipeline.

    Chunker instances are created once and reused across calls — they are
    stateless (all chunking parameters come from the request, not from
    instance state), except DoclingChunker which caches the DocumentConverter.
    """

    def __init__(self) -> None:
        self._chunkers: dict[ChunkerLibrary, TextChunker] = {
            lib: cls() for lib, cls in _LIBRARY_MAP.items()
        }

    def chunk_text(self, request: ChunkRequest) -> ChunkResponse:
        """Chunk text and return a :class:`ChunkResponse`.

        Args:
            request: Validated chunking parameters including content, strategy,
                     library selection, chunk size, and overlap.

        Returns:
            A :class:`ChunkResponse` containing all chunks plus summary metadata.

        Raises:
            HTTPException 400: If the requested library is not registered.
        """
        chunker = self._chunkers.get(request.chunker_library)
        if chunker is None:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown chunker library '{request.chunker_library}'",
            )
        chunks = chunker.chunk(request)

        avg_chars = int(sum(len(c.content) for c in chunks) / len(chunks)) if chunks else 0
        logger.info(
            "Chunking complete: library=%s strategy=%s chunk_size=%d chunk_overlap=%d "
            "chunks=%d avg_chunk_chars=%d",
            request.chunker_library, request.chunker_type,
            request.chunk_size, request.chunk_overlap,
            len(chunks), avg_chars,
        )

        return ChunkResponse(
            chunks=chunks,
            total_chunks=len(chunks),
            chunker_type=request.chunker_type,
            chunker_library=request.chunker_library,
        )


# ---------------------------------------------------------------------------
# Top-level worker functions for ProcessPoolExecutor
# ---------------------------------------------------------------------------

_worker_chunker: "ChunkingService | None" = None


def _init_chunk_worker() -> None:
    """Initializer executed once per worker process at startup."""
    import logging as _logging
    _logging.basicConfig(
        level=_logging.INFO,
        format="%(asctime)s [%(processName)s] %(levelname)s %(name)s — %(message)s",
    )

    global _worker_chunker
    try:
        _worker_chunker = ChunkingService()
    except Exception as exc:
        _logging.getLogger(__name__).warning(
            "ChunkingService initialisation failed in worker: %s", exc
        )


def chunk_file_in_process(filename: str, settings_dict: dict) -> dict:
    """Chunk a document's markdown file in a worker process and save the result.

    Args:
        filename:      Document filename (e.g. ``report.pdf``). Used to locate
                       the corresponding ``.md`` file in ``MDS_DIR`` and as the
                       key for the saved chunk file.
        settings_dict: Splitting parameters (chunker_type, chunker_library,
                       chunk_size, chunk_overlap, enable_markdown_sizing).

    Returns:
        On success: ``{"success": True, "total_chunks": N, "chunker_type": ...,
                       "chunker_library": ..., "chunks": [...]}``.
        On failure: ``{"success": False, "error": "..."}``.
    """
    if _worker_chunker is None:
        return {
            "success": False,
            "error": "Worker process not initialised — _init_chunk_worker did not complete",
        }

    from pathlib import Path
    from backend.config import get_settings
    from backend.services.chunk_storage_service import ChunkStorageService

    s = get_settings()
    stem = Path(filename).stem
    md_path = Path(s.MDS_DIR) / f"{stem}.md"

    if not md_path.exists():
        return {"success": False, "error": f"Markdown file not found for '{filename}'"}

    try:
        content = md_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"success": False, "error": f"Failed to read markdown: {exc}"}

    try:
        request = ChunkRequest(content=content, **settings_dict)
        result = _worker_chunker.chunk_text(request)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}

    try:
        ChunkStorageService().save_chunks(SaveChunksRequest(
            filename=filename,
            chunks=[c.model_dump() for c in result.chunks],
            chunker_type=result.chunker_type,
            chunker_library=result.chunker_library,
        ))
    except Exception as exc:
        logger.warning("Failed to save chunks for '%s': %s", filename, exc)

    return {
        "success": True,
        "total_chunks": result.total_chunks,
        "chunker_type": result.chunker_type,
        "chunker_library": result.chunker_library,
        "chunks": [c.model_dump() for c in result.chunks],
    }
