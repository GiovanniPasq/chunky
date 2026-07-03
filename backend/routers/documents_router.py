"""
Router for document management endpoints.

Prefix: /api

CPU-bound converters run in a process pool owned by the current SSE batch.
Interrupting the batch terminates those worker processes, so running
conversions stop without affecting another request.
VLM and Cloud converters are I/O-bound and run via ``asyncio.to_thread`` with a
threading stop event for cooperative cancellation.

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
from dataclasses import dataclass, field
import logging
import re
import threading
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import AsyncGenerator

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from backend.config import get_settings
from backend.models.schemas import (
    CheckpointInfoResponse,
    ConvertPreviewRequest,
    ConvertPreviewResponse,
    ConvertRequest,
    ConvertResponse,
    ConverterType,
    DeleteResponse,
    DocumentInfo,
    MarkdownContentResponse,
    MarkdownVersionsResponse,
    MdToPdfResponse,
    MultiUploadResponse,
    SaveMarkdownRequest,
)
from backend.services.document_service import (
    DocumentService,
    _init_cpu_worker,
    convert_in_process,
    create_pdf_temp_path,
    preview_in_process,
    render_markdown_pdf_in_process,
)
from backend.utils.executor import terminate_process_pool
from backend.utils.sse import (
    run_sse_event_loop,
    sse_event as _sse,
)

router = APIRouter(prefix="/api", tags=["documents"])
_svc = DocumentService()
logger = logging.getLogger(__name__)


# Converters dispatched to a request-owned ProcessPoolExecutor because they
# are CPU-bound. VLM and Cloud are I/O-bound HTTP workflows and run in threads.
_CPU_BOUND_CONVERTERS = frozenset({
    ConverterType.pymupdf,
    ConverterType.docling,
    ConverterType.markitdown,
    ConverterType.liteparse,
})

_PREVIEW_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")


@dataclass
class _PreviewCancelHandle:
    """Cancellation state for one read-only converter preview request."""

    stop_event: threading.Event = field(default_factory=threading.Event)
    executor: ProcessPoolExecutor | ThreadPoolExecutor | None = None
    futures: list = field(default_factory=list)
    process_pool: bool = False
    terminated: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def cancel(self, wait_timeout_s: float | None = None) -> None:
        """Signal cooperative work and hard-stop owned process workers."""
        self.stop_event.set()
        for future in list(self.futures):
            future.cancel()
        async with self.lock:
            if self.process_pool and self.executor is not None and not self.terminated:
                self.terminated = True
                await terminate_process_pool(
                    self.executor,
                    list(self.futures),
                    label="converter preview worker",
                    logger=logger,
                )
            elif wait_timeout_s is not None:
                for future in list(self.futures):
                    wrapped = asyncio.wrap_future(future)
                    wrapped.add_done_callback(_consume_future_exception)
                    try:
                        if await _wait_for_worker_future(wrapped, wait_timeout_s):
                            _consume_future_exception(wrapped)
                    except (asyncio.CancelledError, Exception):
                        pass


_preview_cancel_handles: dict[str, _PreviewCancelHandle] = {}
_preview_cancel_handles_lock = asyncio.Lock()


def _consume_future_exception(future) -> None:
    """Drain a cancelled worker future so expected cancellation is not logged."""
    try:
        future.exception()
    except BaseException:
        pass


async def _wait_for_worker_future(future, timeout_s: float | None) -> bool:
    """Wait for a worker future without cancelling its wrapper on timeout."""
    done, _ = await asyncio.wait({future}, timeout=timeout_s)
    return bool(done)


def _normalise_preview_id(preview_id: str | None) -> str | None:
    if preview_id is None:
        return None
    if not _PREVIEW_ID_RE.fullmatch(preview_id):
        raise HTTPException(status_code=422, detail="Invalid preview_id")
    return preview_id


async def _register_preview_handle(preview_id: str | None, handle: _PreviewCancelHandle) -> None:
    if preview_id is None:
        return
    async with _preview_cancel_handles_lock:
        if preview_id in _preview_cancel_handles:
            raise HTTPException(status_code=409, detail="Preview id is already active")
        _preview_cancel_handles[preview_id] = handle


async def _unregister_preview_handle(preview_id: str | None, handle: _PreviewCancelHandle) -> None:
    if preview_id is None:
        return
    async with _preview_cancel_handles_lock:
        if _preview_cancel_handles.get(preview_id) is handle:
            _preview_cancel_handles.pop(preview_id, None)


@router.post("/convert/preview/{preview_id}/cancel")
async def cancel_preview_conversion(preview_id: str):
    """Explicitly cancel a read-only converter preview by client id."""
    preview_id = _normalise_preview_id(preview_id)
    async with _preview_cancel_handles_lock:
        handle = _preview_cancel_handles.get(preview_id)
    if handle is None:
        return {"success": True, "cancelled": False}
    await handle.cancel(get_settings().SSE_CANCEL_WAIT_TIMEOUT_S)
    return {"success": True, "cancelled": True}


# ── Read endpoints ────────────────────────────────────────────────────────────

@router.get("/documents", response_model=list[str])
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


# ── Versioned Markdown listing / fetch ────────────────────────────────────────

@router.get(
    "/documents/{document_name}/markdowns",
    response_model=MarkdownVersionsResponse,
)
async def list_markdown_versions(document_name: str):
    """Return every available Markdown version for a document.

    Each entry distinguishes between converted variants
    (``source="converted"``, with the parsed converter token) and uploaded
    files (``source="uploaded"``, ``converter=null``).  This is the data
    backing the frontend's Markdown-version dropdown.
    """
    versions = await asyncio.to_thread(_svc.list_markdown_versions, document_name)
    return MarkdownVersionsResponse(document_name=document_name, versions=versions)


@router.get(
    "/documents/{document_name}/markdowns/{identifier}",
    response_model=MarkdownContentResponse,
)
async def get_markdown_version(document_name: str, identifier: str):
    """Return the full text of one specific Markdown version.

    ``identifier`` may be either a converter name (e.g. ``pymupdf4llm``,
    ``docling``) or the original filename (for uploaded MDs whose name
    does not match the converter pattern).
    """
    return await asyncio.to_thread(_svc.get_markdown_content, document_name, identifier)


@router.put(
    "/documents/{document_name}/markdowns/{md_filename}",
    response_model=MarkdownContentResponse,
)
async def save_markdown_version(
    document_name: str,
    md_filename: str,
    body: SaveMarkdownRequest,
):
    """Save edits to one Markdown artifact under its explicit owner."""
    return await asyncio.to_thread(
        _svc.save_markdown_content,
        document_name,
        md_filename,
        body.content,
    )


# ── VLM checkpoint inspection ─────────────────────────────────────────────────

@router.get(
    "/documents/{document_name}/checkpoint",
    response_model=CheckpointInfoResponse,
)
async def get_vlm_checkpoint(document_name: str):
    """Return the VLM checkpoint state for a document.

    The frontend calls this before kicking off a VLM conversion to decide
    whether to surface a "Resume available" indicator alongside the
    progress modal.  Reports ``exists=false`` (and an empty
    ``completed_pages`` list) when no checkpoint is on disk.
    """
    info = await asyncio.to_thread(_svc.get_vlm_checkpoint_info, document_name)
    return CheckpointInfoResponse(**info)


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/upload", response_model=MultiUploadResponse)
async def upload_files(files: list[UploadFile] = File(...)):
    """Upload one or more PDF / Markdown files."""
    return await asyncio.to_thread(_svc.upload_files, files)


# ── Read-only converter preview ─────────────────────────────────────────────

@router.post("/convert/preview", response_model=ConvertPreviewResponse)
async def preview_conversion(http_request: Request, request: ConvertPreviewRequest):
    """Preview a converter on a small page range without writing Markdown."""
    _settings = get_settings()
    poll_s = 0.1
    cancel_wait_s = _settings.SSE_CANCEL_WAIT_TIMEOUT_S
    preview_id = _normalise_preview_id(request.preview_id)
    handle = _PreviewCancelHandle(
        process_pool=request.converter in _CPU_BOUND_CONVERTERS,
    )
    await _register_preview_handle(preview_id, handle)

    if request.converter in _CPU_BOUND_CONVERTERS:
        executor: ProcessPoolExecutor | None = None
        future = None
        try:
            executor = ProcessPoolExecutor(
                max_workers=1,
                initializer=_init_cpu_worker,
                max_tasks_per_child=_settings.CPU_WORKER_MAX_TASKS_PER_CHILD or None,
            )
            handle.executor = executor
            future = executor.submit(
                preview_in_process,
                request.filename,
                request.converter,
                request.start_page,
                request.end_page,
            )
            handle.futures = [future]
            wrapped = asyncio.wrap_future(future)
            wrapped.add_done_callback(_consume_future_exception)
            while not wrapped.done():
                if handle.stop_event.is_set():
                    await handle.cancel()
                    raise HTTPException(status_code=499, detail="Converter preview cancelled")
                if await http_request.is_disconnected():
                    await handle.cancel()
                    raise HTTPException(status_code=499, detail="Converter preview cancelled")
                try:
                    if not await _wait_for_worker_future(wrapped, poll_s):
                        continue
                except asyncio.CancelledError:
                    if handle.stop_event.is_set():
                        raise HTTPException(status_code=499, detail="Converter preview cancelled")
                    raise
                except Exception:
                    if handle.stop_event.is_set():
                        raise HTTPException(status_code=499, detail="Converter preview cancelled")
                    raise
            try:
                return wrapped.result()
            except asyncio.CancelledError:
                if handle.stop_event.is_set():
                    raise HTTPException(status_code=499, detail="Converter preview cancelled")
                raise
            except Exception:
                if handle.stop_event.is_set():
                    raise HTTPException(status_code=499, detail="Converter preview cancelled")
                raise
        except asyncio.CancelledError:
            await handle.cancel()
            raise
        finally:
            await _unregister_preview_handle(preview_id, handle)
            if executor is not None and not handle.terminated:
                await asyncio.to_thread(
                    executor.shutdown,
                    wait=not handle.stop_event.is_set(),
                    cancel_futures=handle.stop_event.is_set(),
                )

    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="preview-converter")
    handle.executor = executor
    future = executor.submit(
        _svc.preview_conversion,
        request.filename,
        converter_type=request.converter,
        start_page=request.start_page,
        end_page=request.end_page,
        vlm_settings=request.vlm,
        cloud_settings=request.cloud,
        stop_event=handle.stop_event,
    )
    handle.futures = [future]
    wrapped = asyncio.wrap_future(future)
    wrapped.add_done_callback(_consume_future_exception)
    try:
        while not wrapped.done():
            if handle.stop_event.is_set():
                future.cancel()
                try:
                    if await _wait_for_worker_future(wrapped, cancel_wait_s):
                        _consume_future_exception(wrapped)
                except (asyncio.CancelledError, Exception):
                    pass
                raise HTTPException(status_code=499, detail="Converter preview cancelled")
            if await http_request.is_disconnected():
                await handle.cancel()
                try:
                    if await _wait_for_worker_future(wrapped, cancel_wait_s):
                        _consume_future_exception(wrapped)
                except (asyncio.CancelledError, Exception):
                    pass
                raise HTTPException(status_code=499, detail="Converter preview cancelled")
            try:
                if not await _wait_for_worker_future(wrapped, poll_s):
                    continue
            except asyncio.CancelledError:
                if handle.stop_event.is_set():
                    raise HTTPException(status_code=499, detail="Converter preview cancelled")
                raise
            except Exception:
                if handle.stop_event.is_set():
                    raise HTTPException(status_code=499, detail="Converter preview cancelled")
                raise
        try:
            return wrapped.result()
        except asyncio.CancelledError:
            if handle.stop_event.is_set():
                raise HTTPException(status_code=499, detail="Converter preview cancelled")
            raise
        except Exception:
            if handle.stop_event.is_set():
                raise HTTPException(status_code=499, detail="Converter preview cancelled")
            raise
    except asyncio.CancelledError:
        await handle.cancel()
        raise
    finally:
        await _unregister_preview_handle(preview_id, handle)
        await asyncio.to_thread(executor.shutdown, wait=False, cancel_futures=True)


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

        _settings = get_settings()
        watchdog_s = _settings.SSE_WATCHDOG_TIMEOUT_S
        queue_timeout_s = _settings.SSE_QUEUE_GET_TIMEOUT_S
        cancel_wait_s = _settings.SSE_CANCEL_WAIT_TIMEOUT_S
        loop = asyncio.get_running_loop()
        is_cpu_bound = request.converter in _CPU_BOUND_CONVERTERS
        batch_executor: ProcessPoolExecutor | None = None
        io_executor: ThreadPoolExecutor | None = None
        executor_terminated = False
        cancel_lock = asyncio.Lock()

        # concurrent.futures.Future objects for in-flight CPU-bound jobs.
        # Tracked so _cancel_all() can call .cancel() on queued-but-not-started
        # futures. Running futures are stopped by terminating this batch's
        # request-owned worker processes.
        _cpu_futures: list = []
        # Concurrent futures survive cancellation of their asyncio wrappers,
        # allowing _cancel_all to await actual cooperative thread completion.
        _io_futures: list = []

        if is_cpu_bound:
            batch_executor = ProcessPoolExecutor(
                max_workers=min(_settings.MAX_CONCURRENT_CONVERSIONS, total),
                initializer=_init_cpu_worker,
                max_tasks_per_child=_settings.CPU_WORKER_MAX_TASKS_PER_CHILD or None,
            )

            async def _dispatch(fn: str, _stop, _on_progress) -> ConvertResponse:
                assert batch_executor is not None
                cf = batch_executor.submit(
                    convert_in_process,
                    fn,
                    request.converter,
                    request.force,
                )
                _cpu_futures.append(cf)
                try:
                    return await asyncio.wrap_future(cf)
                finally:
                    try:
                        _cpu_futures.remove(cf)
                    except ValueError:
                        pass
        else:
            io_executor = ThreadPoolExecutor(
                max_workers=min(_settings.MAX_CONCURRENT_CONVERSIONS, total),
                thread_name_prefix="converter",
            )

            async def _dispatch(fn: str, _stop, _on_progress) -> ConvertResponse:
                assert io_executor is not None
                cf = io_executor.submit(
                    _svc.convert_to_markdown,
                    fn,
                    converter_type=request.converter,
                    vlm_settings=request.vlm,
                    cloud_settings=request.cloud,
                    stop_event=_stop,
                    on_progress=_on_progress,
                    force=request.force,
                )
                _io_futures.append(cf)
                try:
                    return await asyncio.wrap_future(cf)
                finally:
                    if cf.done():
                        try:
                            _io_futures.remove(cf)
                        except ValueError:
                            pass

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
                    # Use put_nowait (no await) for both events so no other
                    # coroutine can interleave between them and produce
                    # out-of-order file_progress percentages on the client.
                    queue.put_nowait({
                        "type": "file_done",
                        "filename": fn,
                        "success": True,
                        "md_filename": result.md_filename,
                        "md_content": result.md_content,
                        "duration_ms": int((time.monotonic() - t0) * 1000),
                        "failed_pages": result.failed_pages,
                        "resumed_pages": result.resumed_pages,
                    })
                except Exception as exc:
                    async with _lock:
                        failed += 1
                        _done = succeeded + failed
                    error_summary = f"{type(exc).__name__}: {str(exc)[:120]}"
                    queue.put_nowait({"type": "file_done", "filename": fn, "success": False, "error": error_summary})
                    logger.warning(
                        "Convert failed for '%s': %s",
                        fn,
                        exc,
                        exc_info=True,
                        extra={"operation": "convert", "file_name": fn},
                    )

                queue.put_nowait({
                    "type": "file_progress",
                    "filename": fn,
                    "current": _done,
                    "total": total,
                    "percentage": round(_done / total * 100),
                })

        async def run_all() -> None:
            tasks = [asyncio.create_task(convert_one(i, fn)) for i, fn in enumerate(filenames)]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for res in results:
                if isinstance(res, Exception) and not isinstance(res, asyncio.CancelledError):
                    logger.error(
                        "Unexpected exception from conversion task: %s",
                        res,
                        exc_info=res,
                        extra={"operation": "convert"},
                    )
            await queue.put(None)  # sentinel

        runner = asyncio.create_task(run_all())

        async def _cancel_all() -> None:
            nonlocal executor_terminated
            io_futures = list(_io_futures)
            # 1. Signal I/O-bound converters (VLM / Cloud) to stop.
            async with _stop_events_lock:
                for se in _stop_events:
                    se.set()

            # 2. Hard-stop this batch's CPU workers.
            async with cancel_lock:
                if batch_executor is not None and not executor_terminated:
                    executor_terminated = True
                    await terminate_process_pool(
                        batch_executor,
                        _cpu_futures,
                        label="converter worker",
                        logger=logger,
                    )

            # 3. Cancel the asyncio runner task.
            runner.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(runner), timeout=cancel_wait_s)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

            # 4. Do not return while a cooperatively cancelled thread still
            # owns conversion work. VLM/Cloud watchers cancel their HTTP calls
            # promptly once the stop event is set.
            if io_futures:
                await asyncio.gather(
                    *(asyncio.wrap_future(future) for future in io_futures),
                    return_exceptions=True,
                )

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
                log_name=f"conversion ({total} doc(s))",
                on_complete=_on_complete,
            ):
                yield frame
        finally:
            if batch_executor is not None and not executor_terminated:
                await asyncio.to_thread(batch_executor.shutdown, wait=True)
            if io_executor is not None:
                await asyncio.to_thread(io_executor.shutdown, wait=True)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── MD → PDF conversion ───────────────────────────────────────────────────────

@router.post(
    "/documents/{document_name}/markdowns/{md_filename}/pdf",
    response_model=MdToPdfResponse,
)
async def convert_md_to_pdf(http_request: Request, document_name: str, md_filename: str):
    """Convert Markdown in a request-owned process that can be hard-cancelled."""
    executor: ProcessPoolExecutor | None = None
    future = None
    temp_path = None
    terminated = False
    try:
        md_path, pdf_path = _svc.prepare_md_to_pdf(document_name, md_filename)
        temp_path = create_pdf_temp_path(pdf_path)
        executor = ProcessPoolExecutor(max_workers=1)
        future = executor.submit(
            render_markdown_pdf_in_process,
            str(md_path),
            str(temp_path),
        )
        wrapped = asyncio.wrap_future(future)
        while not wrapped.done():
            if await http_request.is_disconnected():
                terminated = True
                await terminate_process_pool(
                    executor,
                    [future],
                    label="Markdown-to-PDF worker",
                    logger=logger,
                )
                raise HTTPException(status_code=499, detail="Markdown-to-PDF conversion cancelled")
            try:
                await asyncio.wait_for(asyncio.shield(wrapped), timeout=0.1)
            except asyncio.TimeoutError:
                continue

        success = wrapped.result()
        return _svc.finish_md_to_pdf(md_filename, pdf_path, temp_path, success)
    except asyncio.CancelledError:
        if executor is not None and not terminated:
            terminated = True
            await terminate_process_pool(
                executor,
                [future] if future is not None else [],
                label="Markdown-to-PDF worker",
                logger=logger,
            )
        raise
    except HTTPException:
        raise
    except Exception:
        logger.exception("Unexpected error in MD→PDF conversion of '%s'", md_filename)
        raise HTTPException(status_code=500, detail="MD to PDF conversion failed due to an internal error")
    finally:
        if executor is not None and not terminated:
            await asyncio.to_thread(executor.shutdown, wait=True)
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@router.delete(
    "/documents/{document_name}/markdowns/{md_filename}",
    response_model=DeleteResponse,
)
async def delete_markdown_variant(document_name: str, md_filename: str):
    """Delete one Markdown variant under its explicit parent document."""
    return await asyncio.to_thread(
        _svc.delete_markdown_variant,
        document_name,
        md_filename,
    )
# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/documents", response_model=DeleteResponse)
async def delete_documents(filenames: list[str]):
    """Delete one or more documents and all their derived files."""
    return await asyncio.to_thread(_svc.delete_documents, filenames)
