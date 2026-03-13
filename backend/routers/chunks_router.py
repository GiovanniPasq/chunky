"""
Router for chunking endpoints.

Prefix: /api
"""

import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import Response

from backend.models.schemas import (
    ChunkRequest,
    ChunkResponse,
    LoadChunksResponse,
    SaveChunksRequest,
    SaveChunksResponse,
)
from backend.services.chunk_storage_service import ChunkStorageService
from backend.services.chunking_service import ChunkingService

router = APIRouter(prefix="/api", tags=["chunks"])
_chunking = ChunkingService()
_storage = ChunkStorageService()


@router.post("/chunk", response_model=ChunkResponse)
async def chunk_text(http_request: Request, request: ChunkRequest):
    """Split text into chunks using the specified strategy and library.

    **splitter_type** controls the splitting algorithm:
    ``token``, ``recursive``, ``character``, ``markdown``.

    **splitter_library** selects the underlying implementation:
    ``langchain`` (default) or ``chonkie``.

    Runs in a thread pool so the event loop stays free for other requests.
    """
    task = asyncio.create_task(
        asyncio.to_thread(_chunking.chunk_text, request)
    )
    try:
        while not task.done():
            if await http_request.is_disconnected():
                task.cancel()
                return Response(status_code=499)
            await asyncio.sleep(0.5)
        return task.result()
    except asyncio.CancelledError:
        return Response(status_code=499)


@router.post("/chunks/save", response_model=SaveChunksResponse)
async def save_chunks(request: SaveChunksRequest):
    """Persist a chunk set to a timestamped JSON file on disk.

    Chunks are stored in the enriched format with placeholder fields for
    ``CleanedChunk``, ``Title``, ``Context``, ``Summary``, ``Keywords``,
    and ``Questions`` — ready for the enrichment pipeline.
    """
    return _storage.save_chunks(request)


@router.get("/chunks/load/{filename}", response_model=LoadChunksResponse)
async def load_chunks(filename: str):
    """Load the most recently saved chunk set for a document."""
    return _storage.load_chunks(filename)
