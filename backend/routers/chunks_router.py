"""
Router for chunking endpoints.

Prefix: /api

POST /api/chunk
    Accepts one or more filenames. Loads each document's saved Markdown from
    disk, splits it using the requested strategy and library, and streams
    progress via Server-Sent Events.  The generated chunks are returned to the
    caller but are not persisted; saving is an explicit follow-up call to
    POST /api/chunks/save.

    Runs in a request-owned ProcessPoolExecutor so CPU-bound splitting work
    runs in isolated processes and the whole batch can be hard-cancelled
    without affecting another request.

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

POST /api/chunks/save
    Persists a chunk set after validating its Markdown source revision.
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ProcessPoolExecutor
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

from backend.config import get_settings
from backend.models.schemas import (
    ChunkFilesRequest,
    ChunksVersionsResponse,
    LoadChunksResponse,
    SaveChunksRequest,
    SaveChunksResponse,
)
from backend.services.chunk_storage_service import ChunkStorageService
from backend.services.chunking_service import _init_chunk_worker, chunk_file_in_process
from backend.utils.executor import terminate_process_pool
from backend.utils.sse import (
    run_sse_event_loop,
    sse_event as _sse,
)

router = APIRouter(prefix="/api", tags=["chunks"])
_storage = ChunkStorageService()


@router.post("/chunk")
async def chunk_documents(http_request: Request, request: ChunkFilesRequest):
    """Chunk one or more documents, streaming progress via SSE.

    Each document's Markdown is loaded from disk, split with the requested
    strategy and library, and streamed as SSE events. Persistence is an
    explicit follow-up request.
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
            # Worker-only transport key — chunking_service strips it before
            # forwarding to ChunkRequest.  Only meaningful for single-file
            # requests; harmless when None.
            "md_filename": request.md_filename if total == 1 else None,
        }

        _settings = get_settings()
        watchdog_s = _settings.SSE_WATCHDOG_TIMEOUT_S
        queue_timeout_s = _settings.SSE_QUEUE_GET_TIMEOUT_S
        cancel_wait_s = _settings.SSE_CANCEL_WAIT_TIMEOUT_S
        semaphore = http_request.app.state.chunk_semaphore
        _cpu_futures: list = []
        batch_executor = ProcessPoolExecutor(
            max_workers=min(_settings.MAX_CONCURRENT_CHUNKING, total),
            initializer=_init_chunk_worker,
            max_tasks_per_child=_settings.CPU_WORKER_MAX_TASKS_PER_CHILD or None,
        )
        executor_terminated = False
        cancel_lock = asyncio.Lock()

        if await http_request.is_disconnected():
            batch_executor.shutdown(wait=False, cancel_futures=True)
            yield _sse({"type": "cancelled"})
            return

        async def _submit(fn: str) -> dict:
            future = batch_executor.submit(chunk_file_in_process, fn, settings_dict)
            _cpu_futures.append(future)
            try:
                return await asyncio.wrap_future(future)
            finally:
                try:
                    _cpu_futures.remove(future)
                except ValueError:
                    pass

        async def chunk_one(idx: int, fn: str) -> None:
            nonlocal succeeded, failed

            async with semaphore:
                if await http_request.is_disconnected():
                    return

                queue.put_nowait({"type": "file_start", "filename": fn, "index": idx + 1, "total": total})

                _done = 0
                try:
                    result = await _submit(fn)

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
            nonlocal executor_terminated
            async with cancel_lock:
                if not executor_terminated:
                    executor_terminated = True
                    await terminate_process_pool(
                        batch_executor,
                        _cpu_futures,
                        label="chunk worker",
                        logger=logger,
                    )
            runner.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(runner), timeout=cancel_wait_s)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        async def _safe_cancel() -> None:
            # Idempotent wrapper: skip cancellation after clean completion.
            if not runner.done():
                await _cancel_all()

        def _handle(event: dict) -> tuple[str, bool]:
            return _sse(event), False

        def _on_complete():
            return [_sse({"type": "batch_done", "succeeded": succeeded, "failed": failed})]

        try:
            async for frame in run_sse_event_loop(
                queue=queue,
                http_request=http_request,
                on_cancel=_safe_cancel,
                handle_event=_handle,
                watchdog_s=watchdog_s,
                queue_timeout_s=queue_timeout_s,
                log_name=f"chunking ({total} job(s))",
                on_complete=_on_complete,
            ):
                yield frame
        finally:
            if not executor_terminated:
                await asyncio.to_thread(batch_executor.shutdown, wait=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/chunks/save", response_model=SaveChunksResponse)
async def save_chunks(request: SaveChunksRequest):
    """Persist a chunk set to a source- and configuration-keyed JSON file."""
    return await asyncio.to_thread(_storage.save_chunks, request)


@router.get(
    "/documents/{document_name}/chunks",
    response_model=ChunksVersionsResponse,
)
async def list_chunks_versions(document_name: str):
    """Return every saved chunks JSON file for a document, newest first.

    Each entry has its source and chunking configuration parsed from the
    filename so the frontend can render a human-readable picker. Legacy
    files that pre-date the new naming scheme appear with
    ``algorithm = "unknown"``.
    """
    versions = await asyncio.to_thread(_storage.list_versions, document_name)
    return ChunksVersionsResponse(document_name=document_name, versions=versions)


@router.get(
    "/documents/{document_name}/chunks/{chunks_filename}",
    response_model=LoadChunksResponse,
)
async def load_chunks_version(document_name: str, chunks_filename: str):
    """Load one specific saved-chunks file by filename."""
    return await asyncio.to_thread(
        _storage.load_chunks_by_filename, document_name, chunks_filename,
    )
