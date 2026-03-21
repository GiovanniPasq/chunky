"""
Router for chunking endpoints.

Prefix: /api

Chunking streams progress via Server-Sent Events (SSE):

    POST /api/chunk
        SSE event types:
            {"type": "start",  "operation": "chunk"}
            {"type": "done",   "operation": "chunk", "chunks": [...],
             "total_chunks": N, "splitter_type": "...", "splitter_library": "..."}
            {"type": "error",  "status": 4xx/5xx, "message": "..."}
            {"type": "cancelled"}
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

from backend.config import get_settings
from backend.models.schemas import (
    ChunkRequest,
    LoadChunksResponse,
    SaveChunksRequest,
    SaveChunksResponse,
)
from backend.services.chunk_storage_service import ChunkStorageService
from backend.services.chunking_service import ChunkingService

router = APIRouter(prefix="/api", tags=["chunks"])
_chunking = ChunkingService()
_storage = ChunkStorageService()


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/chunk")
async def chunk_text(http_request: Request, request: ChunkRequest):
    """Split text into chunks using the specified strategy and library, streaming
    the result via SSE.

    **splitter_type** controls the splitting algorithm:
    ``token``, ``recursive``, ``character``, ``markdown``.

    **splitter_library** selects the underlying implementation:
    ``langchain`` (default) or ``chonkie``.

    SSE events: ``start`` → ``done`` (or ``error`` / ``cancelled``).
    Runs in a thread pool so the event loop stays free for other requests.
    """

    async def event_stream() -> AsyncGenerator[str, None]:
        if await http_request.is_disconnected():
            yield _sse({"type": "cancelled"})
            return

        yield _sse({"type": "start", "operation": "chunk"})

        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        timeout = float(watchdog_s) if watchdog_s > 0 else None

        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(_chunking.chunk_text, request),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            logger.error(
                "Chunking watchdog fired: no result for %.0fs — aborting",
                watchdog_s,
            )
            yield _sse({
                "type": "error",
                "status": 504,
                "message": f"No result for {watchdog_s}s — operation timed out",
            })
            return
        except asyncio.CancelledError:
            yield _sse({"type": "cancelled"})
            return
        except HTTPException as exc:
            yield _sse({"type": "error", "status": exc.status_code, "message": exc.detail})
            return
        except Exception as exc:
            logger.exception("Unexpected error during chunking")
            yield _sse({"type": "error", "status": 500, "message": str(exc)})
            return

        yield _sse({
            "type": "done",
            "operation": "chunk",
            "chunks": [c.model_dump() for c in result.chunks],
            "total_chunks": result.total_chunks,
            "splitter_type": result.splitter_type,
            "splitter_library": result.splitter_library,
        })

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
