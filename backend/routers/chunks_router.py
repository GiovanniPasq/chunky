"""
Router for chunking endpoints.

Prefix: /api

POST /api/chunk
    Accepts one or more filenames. Loads each document's saved Markdown from
    disk, splits it using the requested strategy and library, saves the resulting
    chunks, and streams progress via Server-Sent Events.

    Runs in a dedicated ProcessPoolExecutor (cpu_chunker_executor) so that
    CPU-bound splitting work runs in isolated processes — no shared GIL, true
    parallelism when multiple documents are chunked concurrently.

    SSE event types (consistent for 1 or N files):
        {"type": "file_start",  "filename": "...", "index": 1, "total": N}
        {"type": "file_done",   "filename": "...", "success": true,
         "total_chunks": N, "chunker_type": "...", "chunker_library": "...",
         "chunks": [...]}
        {"type": "file_done",   "filename": "...", "success": false, "error": "..."}
        {"type": "file_progress","filename": "...", "current": 1, "total": N, "percentage": 50}
        {"type": "batch_done",  "succeeded": N, "failed": M}
        {"type": "error",       "status": 4xx/5xx, "message": "..."}
        {"type": "cancelled"}

GET  /api/chunks/load/{filename}
POST /api/chunks/save
    Standard JSON endpoints for persisting and retrieving chunk sets.
"""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ProcessPoolExecutor
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

from backend.config import get_settings
from backend.models.schemas import (
    ChunkFilesRequest,
    LoadChunksResponse,
    SaveChunksRequest,
    SaveChunksResponse,
)
from backend.services.chunk_storage_service import ChunkStorageService
from backend.services.chunking_service import _init_chunk_worker, chunk_file_in_process
from backend.utils.executor import cancel_cpu_executor
from backend.utils.sse import sse_error as _sse_error, sse_event as _sse, sse_timeout_tick

router = APIRouter(prefix="/api", tags=["chunks"])
_storage = ChunkStorageService()


@router.post("/chunk")
async def chunk_documents(http_request: Request, request: ChunkFilesRequest):
    """Chunk one or more documents, streaming progress via SSE.

    Each document's Markdown is loaded from disk, split with the requested
    strategy and library, saved, and its result streamed as SSE events.
    Jobs run concurrently in a ProcessPoolExecutor (up to MAX_CONCURRENT_CHUNKING).

    SSE events: ``file_start`` → ``file_done`` × N → ``batch_done``
    (or ``error`` / ``cancelled``).
    """

    async def event_stream() -> AsyncGenerator[str, None]:
        filenames = request.filenames
        total = len(filenames)
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        succeeded = 0
        failed = 0
        _lock = asyncio.Lock()

        settings_dict = {
            "chunker_type": request.chunker_type.value,
            "chunker_library": request.chunker_library.value,
            "chunk_size": request.chunk_size,
            "chunk_overlap": request.chunk_overlap,
            "enable_markdown_sizing": request.enable_markdown_sizing,
        }

        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        executor: ProcessPoolExecutor = http_request.app.state.cpu_chunker_executor
        semaphore = http_request.app.state.chunk_semaphore
        _cpu_futures: list = []

        if await http_request.is_disconnected():
            yield _sse({"type": "cancelled"})
            return

        async def chunk_one(idx: int, fn: str) -> None:
            nonlocal succeeded, failed

            async with semaphore:
                if await http_request.is_disconnected():
                    return

                queue.put_nowait({"type": "file_start", "filename": fn, "index": idx + 1, "total": total})

                cf = executor.submit(chunk_file_in_process, fn, settings_dict)
                _cpu_futures.append(cf)
                _done = 0
                try:
                    try:
                        result = await asyncio.wrap_future(cf)
                    finally:
                        try:
                            _cpu_futures.remove(cf)
                        except ValueError:
                            pass

                    async with _lock:
                        if result.get("success"):
                            succeeded += 1
                        else:
                            failed += 1
                        _done = succeeded + failed
                    # Use put_nowait for both so no coroutine can interleave
                    # between them and produce out-of-order file_progress %.
                    queue.put_nowait({"type": "file_done", "filename": fn, **result})

                except Exception as exc:
                    async with _lock:
                        failed += 1
                        _done = succeeded + failed
                    error_summary = f"{type(exc).__name__}: {str(exc)[:120]}"
                    queue.put_nowait({"type": "file_done", "filename": fn, "success": False, "error": error_summary})
                    logger.warning("Chunk failed for '%s': %s", fn, exc, exc_info=True)

                queue.put_nowait({
                    "type": "file_progress",
                    "filename": fn,
                    "current": _done,
                    "total": total,
                    "percentage": round(_done / total * 100),
                })

        async def run_all() -> None:
            tasks = [asyncio.create_task(chunk_one(i, fn)) for i, fn in enumerate(filenames)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for res in results:
                if isinstance(res, Exception) and not isinstance(res, asyncio.CancelledError):
                    logger.error("Unexpected exception from chunk task: %s", res, exc_info=res)
            await queue.put(None)

        runner = asyncio.create_task(run_all())

        async def _cancel_all() -> None:
            s = get_settings()
            await cancel_cpu_executor(
                _cpu_futures,
                http_request.app.state,
                "cpu_chunker_executor",
                s.MAX_CONCURRENT_CHUNKING,
                _init_chunk_worker,
                "chunk worker",
                logger,
            )
            runner.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(runner), timeout=10.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        last_event = time.monotonic()
        last_heartbeat = time.monotonic()

        try:
            while True:
                if await http_request.is_disconnected():
                    logger.info("Client disconnected — cancelling %d chunk job(s)", total)
                    await _cancel_all()
                    yield _sse({"type": "cancelled"})
                    return

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    last_heartbeat, do_heartbeat, watchdog_fired = sse_timeout_tick(
                        last_event, last_heartbeat, watchdog_s
                    )
                    if do_heartbeat:
                        yield ": heartbeat\n\n"
                    if watchdog_fired:
                        logger.error(
                            "Chunk watchdog fired: no event for %.0fs — cancelling all jobs", watchdog_s
                        )
                        await _cancel_all()
                        yield _sse_error(504, f"No progress for {watchdog_s:.0f}s — operation timed out")
                        return
                    continue

                if event is None:
                    break

                yield _sse(event)
                last_event = last_heartbeat = time.monotonic()

            yield _sse({"type": "batch_done", "succeeded": succeeded, "failed": failed})
        except asyncio.CancelledError:
            await _cancel_all()
            yield _sse({"type": "cancelled"})
        finally:
            if not runner.done():
                runner.cancel()
                await asyncio.gather(runner, return_exceptions=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/chunks/save", response_model=SaveChunksResponse)
async def save_chunks(request: SaveChunksRequest):
    """Persist a chunk set to a timestamped JSON file on disk."""
    return await asyncio.to_thread(_storage.save_chunks, request)


@router.get("/chunks/load/{filename}", response_model=LoadChunksResponse)
async def load_chunks(filename: str):
    """Load the most recently saved chunk set for a document."""
    return await asyncio.to_thread(_storage.load_chunks, filename)
