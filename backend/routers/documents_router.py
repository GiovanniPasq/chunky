"""
Router for document management endpoints.

Prefix: /api

# VERSION 3 — Per-batch ProcessPoolExecutor for CPU-bound converters
# CPU-bound converters (PyMuPDF, Docling, MarkItDown) now run in a dedicated
# per-batch ProcessPoolExecutor so that cancellation can terminate worker
# processes cleanly without breaking a shared pool.
# VLM and Cloud converters continue to run via asyncio.to_thread (I/O-bound).
#
# Cancellation path:
#   1. stop_events are set for all I/O-bound (VLM/Cloud) conversions.
#   2. concurrent.futures.Future objects are cancelled for CPU-bound work.
#   3. Worker processes in the per-batch executor are terminated via SIGTERM.
#   4. The per-batch executor is shut down; the OS reaps the workers.

Conversion streams progress via Server-Sent Events (SSE):

    POST /api/convert
        Accepts one or more filenames.  Runs up to MAX_CONCURRENT_CONVERSIONS
        in parallel; remaining files are queued server-side.

        SSE event types (consistent for 1 or N files):
            {"type": "file_start",    "filename": "...", "index": 1, "total": N}
            {"type": "progress",      "filename": "...", "current": 3, "total": 10, "percentage": 30}
                -- VLM/Cloud only; emitted after each page / after API responds
            {"type": "file_done",     "filename": "...", "success": true,
             "md_filename": "...", "md_content": "..."}
            {"type": "file_done",     "filename": "...", "success": false, "error": "..."}
            {"type": "file_progress", "filename": "...", "current": 1, "total": N, "percentage": 33}
                -- emitted after every file completes (success or failure)
            {"type": "batch_done",    "succeeded": N, "failed": M}
            {"type": "error",         "status": 4xx/5xx, "message": "..."}
            {"type": "cancelled"}
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from typing import AsyncGenerator, List

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from backend.config import get_settings
from backend.models.schemas import (
    ConvertRequest,
    ConvertResponse,
    ConverterType,
    DeleteResponse,
    DocumentInfo,
    MdToPdfResponse,
    MultiUploadResponse,
)
from backend.services.document_service import (
    DocumentService,
    _init_cpu_worker,
    convert_in_process,
    convert_md_to_pdf_in_process,
)
from backend.utils.sse import sse_error as _sse_error, sse_event as _sse, sse_watchdog_timeout as _watchdog_timeout

router = APIRouter(prefix="/api", tags=["documents"])
_svc = DocumentService()
logger = logging.getLogger(__name__)

# Converters that run in a per-batch ProcessPoolExecutor (CPU-bound).
# VLM and Cloud are excluded — they are I/O-bound (HTTP calls) and run in threads.
_CPU_BOUND_CONVERTERS = frozenset({
    ConverterType.pymupdf,
    ConverterType.docling,
    ConverterType.markitdown,
})


# ── Read endpoints ────────────────────────────────────────────────────────────

@router.get("/documents", response_model=List[str])
async def list_documents():
    """Return a sorted list of all available document filenames."""
    return await asyncio.to_thread(_svc.list_documents)


@router.get("/documents/metadata")
async def list_documents_metadata():
    """Return metadata (including has_markdown) for every document."""
    return await asyncio.to_thread(_svc.list_documents_metadata)


@router.get("/document/{filename}", response_model=DocumentInfo)
async def get_document(filename: str):
    """Return metadata and existing Markdown content for a document."""
    return await asyncio.to_thread(_svc.get_document, filename)


@router.get("/pdf/{filename}")
async def serve_pdf(filename: str):
    """Serve a PDF file for inline viewing or download."""
    pdf_path = _svc.get_pdf_path(filename)
    return FileResponse(pdf_path, media_type="application/pdf", filename=filename)


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/upload", response_model=MultiUploadResponse)
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload one or more PDF / Markdown files."""
    return await asyncio.to_thread(_svc.upload_files, files)


# ── Unified conversion endpoint (SSE) ────────────────────────────────────────

@router.post("/convert")
async def convert_pdfs(
    http_request: Request,
    request: ConvertRequest,
):
    """Convert one or more PDFs to Markdown, streaming progress via SSE."""

    async def event_stream() -> AsyncGenerator[str, None]:
        semaphore = http_request.app.state.conversion_semaphore
        filenames = request.filenames
        total = len(filenames)
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        succeeded = 0
        failed = 0
        _lock = asyncio.Lock()

        _stop_events: list[threading.Event] = []
        _stop_events_lock = asyncio.Lock()

        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        loop = asyncio.get_running_loop()
        is_cpu_bound = request.converter in _CPU_BOUND_CONVERTERS

        # concurrent.futures.Future objects for in-flight CPU-bound jobs.
        # Tracked so _cancel_all() can call .cancel() on queued-but-not-started
        # futures.  Already-running futures cannot be cancelled without
        # terminating the worker process, which would break the shared pool;
        # those jobs run to completion and their results are simply discarded.
        _cpu_futures: list = []

        if is_cpu_bound:
            _shared_executor = http_request.app.state.cpu_converter_executor

            async def _dispatch(fn: str, _stop, _on_progress) -> ConvertResponse:
                cf = _shared_executor.submit(convert_in_process, fn, request.converter)
                _cpu_futures.append(cf)
                try:
                    return await asyncio.wrap_future(cf)
                finally:
                    try:
                        _cpu_futures.remove(cf)
                    except ValueError:
                        pass
        else:
            async def _dispatch(fn: str, _stop, _on_progress) -> ConvertResponse:
                return await asyncio.to_thread(
                    _svc.convert_to_markdown,
                    fn,
                    converter_type=request.converter,
                    vlm_settings=request.vlm,
                    cloud_settings=request.cloud,
                    stop_event=_stop,
                    on_progress=_on_progress,
                )

        async def convert_one(idx: int, fn: str) -> None:
            nonlocal succeeded, failed

            # stop_event is only meaningful for I/O-bound converters (VLM/Cloud).
            # CPU-bound converters run in isolated processes and cannot receive
            # a threading.Event across the process boundary.
            stop = threading.Event() if not is_cpu_bound else None
            if stop is not None:
                async with _stop_events_lock:
                    _stop_events.append(stop)

            async with semaphore:
                if await http_request.is_disconnected():
                    return

                await queue.put({"type": "file_start", "filename": fn, "index": idx + 1, "total": total})

                def _on_progress(current: int, total_pages: int) -> None:
                    try:
                        loop.call_soon_threadsafe(
                            queue.put_nowait,
                            {
                                "type": "progress",
                                "filename": fn,
                                "current": current,
                                "total": total_pages,
                                "file_index": idx + 1,
                                "file_total": total,
                                "percentage": round(current / total_pages * 100) if total_pages else 0,
                            },
                        )
                    except Exception as _err:
                        logger.warning("Failed to queue progress event for '%s': %s", fn, _err)

                t0 = time.monotonic()
                _done = 0
                try:
                    result = await _dispatch(fn, stop, _on_progress)

                    async with _lock:
                        succeeded += 1
                        _done = succeeded + failed
                    await queue.put({
                        "type": "file_done",
                        "filename": fn,
                        "success": True,
                        "md_filename": result.md_filename,
                        "md_content": result.md_content,
                        "duration_ms": int((time.monotonic() - t0) * 1000),
                    })
                except Exception as exc:
                    async with _lock:
                        failed += 1
                        _done = succeeded + failed
                    error_summary = f"{type(exc).__name__}: {str(exc)[:120]}"
                    await queue.put({"type": "file_done", "filename": fn, "success": False, "error": error_summary})
                    logger.warning(
                        "Convert failed for '%s': %s",
                        fn,
                        exc,
                        exc_info=True,
                        extra={"operation": "convert", "file_name": fn},
                    )

                await queue.put({
                    "type": "file_progress",
                    "filename": fn,
                    "current": _done,
                    "total": total,
                    "percentage": round(_done / total * 100),
                })

        async def run_all() -> None:
            tasks = [asyncio.create_task(convert_one(i, fn)) for i, fn in enumerate(filenames)]
            await asyncio.gather(*tasks, return_exceptions=True)
            await queue.put(None)  # sentinel

        runner = asyncio.create_task(run_all())

        async def _cancel_all() -> None:
            # 1. Signal I/O-bound converters (VLM / Cloud) to stop.
            async with _stop_events_lock:
                for se in _stop_events:
                    se.set()

            # 2. Cancel queued CPU-bound futures.
            #    Future.cancel() returns True only for futures not yet picked up
            #    by a worker.  Futures already running in a worker return False.
            still_running: list = []
            for f in list(_cpu_futures):
                if not f.cancel():
                    still_running.append(f)

            # 3. Terminate worker processes that are executing in-flight jobs.
            #    The only way to stop a running ProcessPoolExecutor job is to
            #    kill the worker process itself.  After termination the pool is
            #    broken, so we atomically replace it in app.state so that the
            #    next batch can use CPU converters without restarting the server.
            if is_cpu_bound and still_running:
                old_executor = http_request.app.state.cpu_converter_executor
                worker_procs = list(getattr(old_executor, '_processes', {}).values())

                for proc in worker_procs:
                    try:
                        proc.terminate()
                    except Exception as exc:
                        logger.debug("Failed to send SIGTERM to worker %d: %s", proc.pid, exc)

                s = get_settings()
                # Replace executor first so concurrent requests get the new one.
                # Rebuild is inside try/finally so old_executor is always retired.
                try:
                    http_request.app.state.cpu_converter_executor = ProcessPoolExecutor(
                        max_workers=s.MAX_CONCURRENT_CONVERSIONS,
                        initializer=_init_cpu_worker,
                        max_tasks_per_child=s.CPU_CONVERTER_MAX_TASKS_PER_CHILD or None,
                    )
                finally:
                    # Register the retired executor for clean teardown at app shutdown.
                    try:
                        http_request.app.state.retired_executors.append(old_executor)
                        old_executor.shutdown(wait=False, cancel_futures=True)
                    except Exception:
                        pass

                # Escalate to SIGKILL in background for any worker that ignores SIGTERM
                # (e.g. stuck inside a C extension).  Runs asynchronously so cancellation
                # returns to the user immediately without waiting.
                async def _escalate_kill(procs: list) -> None:
                    await asyncio.sleep(3.0)
                    for p in procs:
                        if p.is_alive():
                            try:
                                p.kill()
                                logger.warning(
                                    "Worker process %d ignored SIGTERM — sent SIGKILL", p.pid
                                )
                            except Exception as exc:
                                logger.debug("Failed to SIGKILL worker %d: %s", p.pid, exc)

                asyncio.create_task(_escalate_kill(worker_procs))

            # 4. Cancel the asyncio runner task.
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
                    logger.info(
                        "Client disconnected — cancelling %d conversion(s)",
                        total,
                        extra={"operation": "convert"},
                    )
                    await _cancel_all()
                    yield _sse({"type": "cancelled"})
                    return

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    if time.monotonic() - last_heartbeat >= 30.0:
                        yield ": heartbeat\n\n"
                        last_heartbeat = time.monotonic()
                        # Do NOT reset last_event here — last_event tracks real
                        # progress; a heartbeat is only a connection keepalive.

                    if watchdog_s > 0 and time.monotonic() - last_event > watchdog_s:
                        logger.error(
                            "SSE watchdog fired: no event for %.0fs — cancelling all conversions",
                            watchdog_s,
                            extra={"operation": "convert"},
                        )
                        await _cancel_all()
                        yield _sse_error(504, f"No progress for {watchdog_s}s — operation timed out")
                        return
                    continue

                if event is None:
                    break

                yield _sse(event)
                last_event = time.monotonic()
                last_heartbeat = time.monotonic()

            yield _sse({"type": "batch_done", "succeeded": succeeded, "failed": failed})
        except asyncio.CancelledError:
            await _cancel_all()
            yield _sse({"type": "cancelled"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── MD → PDF conversion ───────────────────────────────────────────────────────

@router.post("/md-to-pdf/{filename}", response_model=MdToPdfResponse)
async def convert_md_to_pdf(filename: str, http_request: Request):
    """Convert a stored Markdown file to PDF using weasyprint."""
    try:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            http_request.app.state.cpu_converter_executor,
            convert_md_to_pdf_in_process,
            filename,
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Unexpected error in MD→PDF conversion of '%s'", filename)
        raise HTTPException(status_code=500, detail="MD to PDF conversion failed due to an internal error")


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/documents", response_model=DeleteResponse)
async def delete_documents(filenames: List[str]):
    """Delete one or more documents and all their derived files."""
    return await asyncio.to_thread(_svc.delete_documents, filenames)
