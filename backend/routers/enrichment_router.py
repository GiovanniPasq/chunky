"""
Router for LLM enrichment endpoints.

Prefix: /api/enrich

Both endpoints stream progress via Server-Sent Events (SSE):

    POST /api/enrich/markdown
        SSE event types:
            {"type": "start",  "operation": "enrich_markdown"}
            {"type": "done",   "operation": "enrich_markdown", "enriched_content": "..."}
            {"type": "error",  "status": 4xx/5xx, "message": "..."}
            {"type": "cancelled"}

    POST /api/enrich/chunks
        SSE event types:
            {"type": "start",      "operation": "enrich_chunks", "total": N}
            {"type": "chunk_done", "operation": "enrich_chunks",
             "current": 1, "total": N, "percentage": 50, "chunk": {...enriched fields...}}
            {"type": "chunk_error","operation": "enrich_chunks",
             "current": 1, "total": N, "chunk_index": 0, "message": "..."}
            {"type": "done",       "operation": "enrich_chunks", "total_chunks": N}
            {"type": "error",      "status": 4xx/5xx, "message": "..."}
            {"type": "cancelled"}
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

from backend.config import get_settings
from backend.models.schemas import (
    EnrichChunksRequest,
    EnrichMarkdownRequest,
)
from backend.services.enrichment_service import EnrichmentService
from backend.utils.sse import sse_error as _sse_error, sse_event as _sse, sse_watchdog_timeout as _watchdog_timeout

router = APIRouter(prefix="/api/enrich", tags=["enrichment"])

_HEARTBEAT_INTERVAL_S = 30.0


def _build_service(request_settings, http_client) -> EnrichmentService:
    s = request_settings
    return EnrichmentService(
        model=s.model,
        base_url=s.base_url,
        api_key=s.api_key,
        temperature=s.temperature,
        user_prompt=s.user_prompt,
        http_client=http_client,
    )


@router.post("/markdown")
async def enrich_markdown(http_request: Request, body: EnrichMarkdownRequest):
    """Enrich a single markdown section with LLM cleanup, streaming the result via SSE.

    The LLM corrects conversion artifacts, fixes formatting, and improves
    readability while preserving all original information.

    SSE events: ``start`` → ``done`` (or ``error`` / ``cancelled``).

    A keepalive heartbeat comment is emitted every 30 s while the LLM call is
    in flight so the frontend's connection-lost watchdog does not fire during
    slow model responses.  A backend watchdog cancels the operation if no
    progress is made for SSE_WATCHDOG_TIMEOUT_S seconds.
    """

    async def event_stream() -> AsyncGenerator[str, None]:
        if await http_request.is_disconnected():
            yield _sse({"type": "cancelled"})
            return

        yield _sse({"type": "start", "operation": "enrich_markdown"})

        http_client = http_request.app.state.http_client_async
        svc = _build_service(body.settings, http_client)

        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def run_enrich() -> None:
            try:
                enriched = await svc.enrich_markdown(body.content)
                await queue.put({"type": "done", "enriched_content": enriched})
            except asyncio.CancelledError:
                await queue.put({"type": "cancelled"})
            except HTTPException as exc:
                await queue.put({"type": "error", "status": exc.status_code, "message": exc.detail})
            except Exception as exc:
                logger.exception("Unexpected error during markdown enrichment")
                await queue.put({"type": "error", "status": 500,
                                 "message": "An internal error occurred. Check server logs."})
            finally:
                await queue.put(None)  # sentinel

        runner = asyncio.create_task(run_enrich())

        last_event = time.monotonic()
        last_heartbeat = time.monotonic()

        try:
            while True:
                if await http_request.is_disconnected():
                    runner.cancel()
                    await asyncio.gather(runner, return_exceptions=True)
                    yield _sse({"type": "cancelled"})
                    return

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    # Emit a keepalive comment every 30 s so the frontend's
                    # connection-lost timer doesn't fire during slow LLM responses.
                    if time.monotonic() - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                        yield ": heartbeat\n\n"
                        last_heartbeat = time.monotonic()
                        # Do NOT reset last_event here — last_event tracks real
                        # progress; a heartbeat is only a connection keepalive.

                    # Watchdog: if no event has arrived for watchdog_s seconds,
                    # something is stuck — cancel and report.
                    if watchdog_s > 0 and time.monotonic() - last_event > watchdog_s:
                        logger.error(
                            "Markdown enrichment watchdog fired: no response for %.0fs — aborting",
                            watchdog_s,
                        )
                        runner.cancel()
                        await asyncio.gather(runner, return_exceptions=True)
                        yield _sse_error(504, f"No response for {watchdog_s:.0f}s — operation timed out")
                        return
                    continue

                if event is None:
                    break

                last_event = time.monotonic()
                last_heartbeat = time.monotonic()

                if event["type"] == "done":
                    yield _sse({"type": "done", "operation": "enrich_markdown", "enriched_content": event["enriched_content"]})
                elif event["type"] == "error":
                    yield _sse_error(event["status"], event["message"])
                elif event["type"] == "cancelled":
                    yield _sse({"type": "cancelled"})
                return

        except asyncio.CancelledError:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
            yield _sse({"type": "cancelled"})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/chunks")
async def enrich_chunks(http_request: Request, body: EnrichChunksRequest):
    """Enrich an array of chunks with LLM-generated metadata, streaming per-chunk events.

    Chunks are processed concurrently (up to MAX_CONCURRENT_ENRICHMENTS in flight
    at once). A ``chunk_done`` event is emitted after each chunk completes so the
    frontend can update the UI incrementally.

    Per-chunk errors are reported as ``chunk_error`` events and do not abort the
    remaining chunks.  A timed-out chunk (after retries) is reported as
    ``chunk_error`` and processing continues with the next chunk.

    A keepalive heartbeat comment is emitted every 30 s during idle periods so
    the frontend's connection-lost watchdog does not fire between slow chunks.
    A backend watchdog cancels all in-flight chunks if no event arrives for
    SSE_WATCHDOG_TIMEOUT_S seconds.

    SSE events: ``start`` → ``chunk_done`` × N → ``done``
    (or ``chunk_error`` for individual failures, ``error`` for fatal errors,
    ``cancelled`` on client disconnect).
    """

    async def event_stream() -> AsyncGenerator[str, None]:
        if await http_request.is_disconnected():
            yield _sse({"type": "cancelled"})
            return

        http_client = http_request.app.state.http_client_async
        svc = _build_service(body.settings, http_client)
        chunks = [c.model_dump() for c in body.chunks]
        total = len(chunks)

        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        # Use the global semaphore from app.state so the cap is enforced across
        # ALL concurrent /enrich/chunks requests, not just within this one call.
        semaphore = http_request.app.state.enrichment_semaphore

        yield _sse({"type": "start", "operation": "enrich_chunks", "total": total})

        queue: asyncio.Queue[dict | None] = asyncio.Queue()

        async def enrich_one(chunk: dict) -> None:
            chunk_index = chunk["index"]
            content = chunk.get("content", "")
            async with semaphore:
                try:
                    enriched = await svc.enrich_chunk(content)
                    result = {
                        "index": chunk_index,
                        "content": content,
                        "cleaned_chunk": enriched.get("cleaned_chunk", ""),
                        "title": enriched.get("title", ""),
                        "context": enriched.get("context", ""),
                        "summary": enriched.get("summary", ""),
                        "keywords": enriched.get("keywords", [])
                            if isinstance(enriched.get("keywords"), list) else [],
                        "questions": enriched.get("questions", [])
                            if isinstance(enriched.get("questions"), list) else [],
                        "metadata": chunk.get("metadata", {}),
                        "start": chunk.get("start", 0),
                        "end": chunk.get("end", 0),
                    }
                    await queue.put({"type": "chunk_done", "chunk": result, "chunk_index": chunk_index})
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.error(
                        "Chunk enrichment failed at index %s (will continue): %s",
                        chunk_index,
                        exc,
                    )
                    await queue.put({"type": "chunk_error", "chunk_index": chunk_index,
                                     "message": "Chunk enrichment failed. Check server logs."})

        async def run_all() -> None:
            tasks = [asyncio.create_task(enrich_one(c)) for c in chunks]
            await asyncio.gather(*tasks, return_exceptions=True)
            await queue.put(None)  # sentinel

        runner = asyncio.create_task(run_all())

        completed = 0
        succeeded = 0
        last_event = time.monotonic()
        last_heartbeat = time.monotonic()

        try:
            while True:
                if await http_request.is_disconnected():
                    runner.cancel()
                    await asyncio.gather(runner, return_exceptions=True)
                    yield _sse({"type": "cancelled"})
                    return

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    # Emit a keepalive comment every 30 s so the frontend's
                    # connection-lost timer doesn't fire between slow chunks.
                    if time.monotonic() - last_heartbeat >= _HEARTBEAT_INTERVAL_S:
                        yield ": heartbeat\n\n"
                        last_heartbeat = time.monotonic()
                        # Do NOT reset last_event here — last_event tracks real
                        # progress; a heartbeat is only a connection keepalive.

                    # Watchdog: if no chunk event has arrived for watchdog_s seconds,
                    # something is stuck — cancel all in-flight chunks.
                    if watchdog_s > 0 and time.monotonic() - last_event > watchdog_s:
                        logger.error(
                            "Chunk enrichment watchdog fired: no event for %.0fs — cancelling all chunks",
                            watchdog_s,
                        )
                        runner.cancel()
                        await asyncio.gather(runner, return_exceptions=True)
                        yield _sse_error(504, f"No progress for {watchdog_s:.0f}s — operation timed out")
                        return
                    continue

                if event is None:
                    break

                completed += 1
                last_event = time.monotonic()
                last_heartbeat = time.monotonic()

                if event["type"] == "chunk_done":
                    succeeded += 1
                    yield _sse({
                        "type": "chunk_done",
                        "operation": "enrich_chunks",
                        "current": completed,
                        "total": total,
                        "percentage": round(completed / total * 100),
                        "chunk": event["chunk"],
                    })
                else:
                    yield _sse({
                        "type": "chunk_error",
                        "operation": "enrich_chunks",
                        "current": completed,
                        "total": total,
                        "chunk_index": event["chunk_index"],
                        "message": event["message"],
                    })

        except asyncio.CancelledError:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)
            yield _sse({"type": "cancelled"})
            return

        yield _sse({
            "type": "done",
            "operation": "enrich_chunks",
            "total_chunks": total,
            "succeeded": succeeded,
        })

    return StreamingResponse(event_stream(), media_type="text/event-stream")
