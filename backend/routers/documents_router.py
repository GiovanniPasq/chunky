"""
Router for document management endpoints.

Prefix: /api

# VERSION 2 — ProcessPoolExecutor for PyMuPDF
# PyMuPDF runs in a separate process (ProcessPoolExecutor) instead of a thread,
# fully eliminating thread-safety risks.
# Other converters (Docling, MarkItDown, VLM) continue to run on the default
# ThreadPoolExecutor via asyncio.to_thread.
#
# LIMITATION: stop_event and on_progress cannot be passed cross-process
# (they are not picklable). For PyMuPDF this is not a practical concern because:
#   - stop_event: PyMuPDF is fast; mid-conversion cancellation is not critical.
#   - on_progress: PyMuPDF does not emit per-page events (only VLM does).

Conversion streams progress via Server-Sent Events (SSE):

    POST /api/convert
        Accepts one or more filenames.  Runs up to MAX_CONCURRENT_CONVERSIONS
        in parallel; remaining files are queued server-side.

        SSE event types (consistent for 1 or N files):
            {"type": "file_start",    "filename": "...", "index": 1, "total": N}
            {"type": "progress",      "filename": "...", "current": 3, "total": 10, "percentage": 30}
                -- VLM only; emitted after each page of a file
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
    ConverterType,
    DeleteResponse,
    DocumentInfo,
    MdToPdfResponse,
    MultiUploadResponse,
)
from backend.services.document_service import DocumentService, convert_pymupdf_in_process
from backend.utils.sse import sse_event as _sse

router = APIRouter(prefix="/api", tags=["documents"])
_svc = DocumentService()
logger = logging.getLogger(__name__)

# ── Executors ─────────────────────────────────────────────────────────────────
# Dedicated ProcessPoolExecutor for PyMuPDF: each worker runs in a separate
# process, so there is no shared state with the main process and PyMuPDF's
# thread-safety constraints do not apply.
# max_workers=None → defaults to os.cpu_count() processes.
_pymupdf_executor: ProcessPoolExecutor | None = None


def _get_pymupdf_executor() -> ProcessPoolExecutor:
    global _pymupdf_executor
    if _pymupdf_executor is None:
        _pymupdf_executor = ProcessPoolExecutor(max_workers=None)
    return _pymupdf_executor


# ── Global conversion semaphore (lazy init) ───────────────────────────────────
# Controls total concurrent conversions across ALL requests (single + batch).
_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(get_settings().MAX_CONCURRENT_CONVERSIONS)
    return _semaphore


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
    """Upload one or more PDF / Markdown files.

    - **.pdf** → ``docs/pdfs/``  (validated: magic bytes + size limit)
    - **.md**  → ``docs/mds/``   (validated: size limit)

    Returns a per-file success / failure summary. Individual failures do not
    abort the batch.
    """
    return await asyncio.to_thread(_svc.upload_files, files)


# ── Unified conversion endpoint (SSE) ────────────────────────────────────────

@router.post("/convert")
async def convert_pdfs(
    http_request: Request,
    request: ConvertRequest,
):
    """Convert one or more PDFs to Markdown, streaming progress via SSE.

    A single file is treated as a batch of one — the response format is
    identical regardless of input count.  Up to MAX_CONCURRENT_CONVERSIONS
    files run in parallel; remaining files are queued server-side.

    VLM conversions emit per-page ``progress`` events in addition to the
    standard ``file_start`` / ``file_done`` / ``file_progress`` events.

    A backend watchdog cancels all in-flight conversions if no SSE event
    (including keepalive comments) has been sent for SSE_WATCHDOG_TIMEOUT_S
    seconds.

    # PyMuPDF jobs are executed via ProcessPoolExecutor (separate process) to work
    # around the library's thread-safety constraints.
    # Other converters use asyncio.to_thread (standard thread pool).
    """

    async def event_stream() -> AsyncGenerator[str, None]:
        semaphore = _get_semaphore()
        filenames = request.filenames
        total = len(filenames)
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        succeeded = 0
        failed = 0
        _lock = asyncio.Lock()

        # All per-file stop_events collected here so a disconnect or watchdog
        # can cancel every in-flight conversion with a single loop.
        _stop_events: list[threading.Event] = []
        _stop_events_lock = asyncio.Lock()

        http_client = http_request.app.state.http_client_sync
        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        loop = asyncio.get_running_loop()

        is_pymupdf = request.converter == ConverterType.pymupdf

        async def convert_one(idx: int, fn: str) -> None:
            nonlocal succeeded, failed
            stop = threading.Event()
            async with _stop_events_lock:
                _stop_events.append(stop)

            async with semaphore:
                if await http_request.is_disconnected():
                    return

                await queue.put({"type": "file_start", "filename": fn, "index": idx + 1, "total": total})

                # Thread-safe callback: the worker thread calls this after each
                # VLM page; it posts a progress event into the async queue.
                # file_index / file_total let the frontend display batch context
                # alongside the per-page numbers.
                def _on_progress(current: int, total_pages: int) -> None:
                    # Note: _on_progress is not passed to PyMuPDF (not picklable cross-process),
                    # but PyMuPDF does not emit per-page events anyway.
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

                t0 = time.monotonic()
                _done = 0
                try:
                    if is_pymupdf:
                        # Run in a separate process: no shared threads, no PyMuPDF crash risk.
                        result = await loop.run_in_executor(
                            _get_pymupdf_executor(),
                            convert_pymupdf_in_process,
                            fn,
                        )
                    else:
                        # VLM, Docling, MarkItDown: standard thread pool.
                        result = await asyncio.to_thread(
                            _svc.convert_to_markdown,
                            fn,
                            converter_type=request.converter,
                            vlm_settings=request.vlm,
                            stop_event=stop,
                            on_progress=_on_progress,
                            http_client=http_client,
                        )

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
                    await queue.put({"type": "file_done", "filename": fn, "success": False, "error": str(exc)})
                    logger.warning(
                        "Convert failed for '%s': %s",
                        fn,
                        exc,
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
            async with _stop_events_lock:
                for se in _stop_events:
                    se.set()
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
                    # Emit a keepalive comment every 30 s so the frontend's
                    # connection-lost timer doesn't fire during slow conversions.
                    if time.monotonic() - last_heartbeat >= 30.0:
                        yield ": heartbeat\n\n"
                        last_heartbeat = time.monotonic()
                        last_event = time.monotonic()

                    # Watchdog: if no event has arrived for watchdog_s seconds,
                    # something is stuck — cancel everything.
                    if watchdog_s > 0 and time.monotonic() - last_event > watchdog_s:
                        logger.error(
                            "SSE watchdog fired: no event for %.0fs — cancelling all conversions",
                            watchdog_s,
                            extra={"operation": "convert"},
                        )
                        await _cancel_all()
                        yield _sse({
                            "type": "error",
                            "status": 504,
                            "message": f"No progress for {watchdog_s}s — operation timed out",
                        })
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
async def convert_md_to_pdf(filename: str):
    """Convert a stored Markdown file to PDF using weasyprint.

    Runs in a thread pool so the event loop stays free for other requests.
    """
    try:
        return await asyncio.to_thread(_svc.convert_md_to_pdf, filename)
    except HTTPException:
        raise
    except Exception:
        logger.exception("Unexpected error in MD→PDF conversion of '%s'", filename)
        raise HTTPException(status_code=500, detail="MD to PDF conversion failed due to an internal error")


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/documents", response_model=DeleteResponse)
async def delete_documents(filenames: List[str]):
    """Delete one or more documents and all their derived files.

    Accepts a JSON array of filenames. Partial success is allowed — the
    response reports which files were not found.
    """
    return await asyncio.to_thread(_svc.delete_documents, filenames)
