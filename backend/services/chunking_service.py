"""
Text chunking service — dispatches to the appropriate chunker library.

The service instantiates a :class:`~backend.chunkers.LangChainChunker`,
:class:`~backend.chunkers.ChonkieChunker`, or :class:`~backend.chunkers.DoclingChunker`
based on :attr:`~backend.models.schemas.ChunkRequest.chunker_library`, then delegates
the actual chunking to the chosen implementation.
"""

from __future__ import annotations

import hashlib
import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)

from backend.models.schemas import ChunkRequest, ChunkResponse, ChunkerLibrary
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

    Chunker instances are created lazily and reused across calls.  This keeps
    basic LangChain / Chonkie chunking independent from Docling's heavyweight
    model and tokenizer initialisation (which may require a first-run download).
    """

    def __init__(self) -> None:
        self._chunkers: dict[ChunkerLibrary, TextChunker] = {}

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
        chunker_cls = _LIBRARY_MAP.get(request.chunker_library)
        if chunker_cls is None:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown chunker library '{request.chunker_library}'",
            )
        chunker = self._chunkers.get(request.chunker_library)
        if chunker is None:
            chunker = chunker_cls()
            self._chunkers[request.chunker_library] = chunker
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
    """Chunk a document's markdown file in a worker process.

    Args:
        filename:      Document filename (e.g. ``report.pdf``). Used to locate
                       the corresponding ``.md`` file in ``MDS_DIR``.
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
    from backend.services.document_files import find_markdown_for_document

    # md_filename is a transport-only field (it tells the worker which MD
    # variant to read); strip it before forwarding the rest into ChunkRequest.
    chunk_settings = {k: v for k, v in settings_dict.items() if k != "md_filename"}
    md_filename = settings_dict.get("md_filename")

    s = get_settings()
    md_path = find_markdown_for_document(
        filename,
        Path(s.MDS_DIR),
        md_filename=md_filename,
    )

    if md_path is None:
        return {"success": False, "error": f"Markdown file not found for '{filename}'"}

    try:
        content = md_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {"success": False, "error": f"Failed to read markdown: {exc}"}

    try:
        request = ChunkRequest(content=content, **chunk_settings)
        result = _worker_chunker.chunk_text(request)
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}

    # Chunk persistence is intentionally NOT triggered here.  Saving must be
    # an explicit, user-driven action via POST /api/chunks/save so that
    # opening a document or switching the chunk view does not pollute the
    # ``chunks/`` directory with files the user never asked for.
    return {
        "success": True,
        "total_chunks": result.total_chunks,
        "chunker_type": result.chunker_type,
        "chunker_library": result.chunker_library,
        "md_filename": md_path.name,
        "source_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        "chunks": [c.model_dump() for c in result.chunks],
    }
