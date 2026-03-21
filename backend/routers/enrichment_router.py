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
import json
import logging
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

router = APIRouter(prefix="/api/enrich", tags=["enrichment"])


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


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
    """

    async def event_stream() -> AsyncGenerator[str, None]:
        if await http_request.is_disconnected():
            yield _sse({"type": "cancelled"})
            return

        yield _sse({"type": "start", "operation": "enrich_markdown"})

        # Shared async client from lifespan — one connection pool for all requests.
        http_client = http_request.app.state.http_client_async
        svc = _build_service(body.settings, http_client)

        watchdog_s = get_settings().SSE_WATCHDOG_TIMEOUT_S
        timeout = float(watchdog_s) if watchdog_s > 0 else None

        try:
            # Directly awaited — no asyncio.to_thread needed now that the service
            # is async.  Cancellation propagates from the generator close to the
            # underlying httpx request automatically.
            # asyncio.wait_for acts as a watchdog: cancels if the LLM call stalls.
            enriched = await asyncio.wait_for(svc.enrich_markdown(body.content), timeout=timeout)
        except asyncio.TimeoutError:
            logger.error(
                "Markdown enrichment watchdog fired: no response for %.0fs — aborting",
                watchdog_s,
            )
            yield _sse({
                "type": "error",
                "status": 504,
                "message": f"No response for {watchdog_s}s — operation timed out",
            })
            return
        except asyncio.CancelledError:
            yield _sse({"type": "cancelled"})
            return
        except HTTPException as exc:
            yield _sse({"type": "error", "status": exc.status_code, "message": exc.detail})
            return
        except Exception as exc:
            logger.exception("Unexpected error during markdown enrichment")
            yield _sse({"type": "error", "status": 500, "message": str(exc)})
            return

        yield _sse({"type": "done", "operation": "enrich_markdown", "enriched_content": enriched})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/chunks")
async def enrich_chunks(http_request: Request, body: EnrichChunksRequest):
    """Enrich an array of chunks with LLM-generated metadata, streaming per-chunk events.

    Each chunk is processed sequentially. A ``chunk_done`` event is emitted after
    each chunk so the frontend can update the UI incrementally without waiting for
    the entire batch.

    Per-chunk errors are reported as ``chunk_error`` events and do not abort the
    remaining chunks.  A timed-out chunk (after retries) is reported as
    ``chunk_error`` and processing continues with the next chunk.

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
        timeout = float(watchdog_s) if watchdog_s > 0 else None

        yield _sse({"type": "start", "operation": "enrich_chunks", "total": total})

        completed = 0
        try:
            for chunk in chunks:
                if await http_request.is_disconnected():
                    yield _sse({"type": "cancelled"})
                    return

                chunk_index = chunk["index"]
                content = chunk.get("content", "")
                current = completed + 1

                try:
                    enriched = await asyncio.wait_for(svc.enrich_chunk(content), timeout=timeout)
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
                    completed += 1
                    yield _sse({
                        "type": "chunk_done",
                        "operation": "enrich_chunks",
                        "current": current,
                        "total": total,
                        "percentage": round(current / total * 100),
                        "chunk": result,
                    })
                except asyncio.CancelledError:
                    yield _sse({"type": "cancelled"})
                    return
                except asyncio.TimeoutError:
                    completed += 1
                    logger.error(
                        "Chunk enrichment watchdog fired at index %s: no response for %.0fs"
                        " — skipping chunk and continuing",
                        chunk_index,
                        watchdog_s,
                    )
                    yield _sse({
                        "type": "chunk_error",
                        "operation": "enrich_chunks",
                        "current": current,
                        "total": total,
                        "chunk_index": chunk_index,
                        "message": f"Timed out after {watchdog_s}s (watchdog)",
                    })
                except Exception as exc:
                    # Any other per-chunk failure: log, emit chunk_error, continue.
                    completed += 1
                    logger.error(
                        "Chunk enrichment failed at index %s (will continue): %s",
                        chunk_index,
                        exc,
                    )
                    yield _sse({
                        "type": "chunk_error",
                        "operation": "enrich_chunks",
                        "current": current,
                        "total": total,
                        "chunk_index": chunk_index,
                        "message": str(exc),
                    })

        except asyncio.CancelledError:
            yield _sse({"type": "cancelled"})
            return

        yield _sse({
            "type": "done",
            "operation": "enrich_chunks",
            "total_chunks": completed,
        })

    return StreamingResponse(event_stream(), media_type="text/event-stream")
