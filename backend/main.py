"""
PDF to Markdown & chunking API.
Entry point: uvicorn backend.main:app --reload
"""

import asyncio
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import get_settings
from backend.logging_config import configure_logging
from backend.services.document_service import _init_cpu_worker
from backend.routers.documents_router import router as documents_router
from backend.routers.chunks_router import router as chunks_router
from backend.routers.capabilities_router import router as capabilities_router
from backend.routers.enrichment_router import router as enrichment_router
from backend.routers.health_router import router as health_router

ALLOWED_ORIGINS = [
    "http://localhost:5173",  # Vite dev server
    "http://localhost:3000",  # CRA / alternate dev server
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(level=settings.LOG_LEVEL, fmt=settings.LOG_FORMAT)

    # One shared connection pool for async callers (enrichment service).
    # Timeout values come from Settings so they can be tuned via environment
    # variables without touching code.
    app.state.http_client_async = httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=settings.HTTP_CONNECT_TIMEOUT_S,
            read=settings.ENRICH_READ_TIMEOUT_S,
            write=10.0,
            pool=settings.HTTP_POOL_TIMEOUT_S,
        )
    )

    # Semaphore that caps total concurrent conversions across all requests.
    # Created here (not lazily in the router) so there is exactly one instance
    # bound to the running event loop — avoiding the race where two concurrent
    # requests both see _semaphore is None and create separate semaphores.
    app.state.conversion_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CONVERSIONS)

    # Global semaphore for LLM enrichment calls across ALL concurrent requests.
    # Without this, each /enrich/chunks request creates its own semaphore, so
    # N simultaneous requests each get MAX_CONCURRENT_ENRICHMENTS slots —
    # the real concurrency would be N × MAX_CONCURRENT_ENRICHMENTS.
    app.state.enrichment_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_ENRICHMENTS)

    # Dedicated process pool for all CPU-bound converters (PyMuPDF, Docling,
    # MarkItDown). Each job runs in an isolated process — no shared GIL, no
    # thread-safety issues, full memory isolation.
    # initializer: loads DocumentService + Docling models once per worker so
    #              jobs don't pay the model-load cost on every call.
    # max_tasks_per_child: recycles workers after N jobs to reclaim accumulated
    #                      ML memory (PyTorch caches, heap fragmentation).
    #                      None means never recycle (when setting is 0).
    app.state.cpu_converter_executor = ProcessPoolExecutor(
        max_workers=settings.MAX_CONCURRENT_CONVERSIONS,
        initializer=_init_cpu_worker,
        max_tasks_per_child=settings.CPU_CONVERTER_MAX_TASKS_PER_CHILD or None,
    )
    # Executors replaced during cancellation are collected here so the lifespan
    # teardown can clean them up even if their worker processes were already killed.
    app.state.retired_executors: list = []

    yield

    await app.state.http_client_async.aclose()
    # Shut down the process pool in a thread so the event loop stays responsive.
    # A 30 s timeout ensures the server can always exit even if a worker is stuck
    # (e.g. inside a C extension ignoring SIGTERM).
    try:
        await asyncio.wait_for(
            asyncio.to_thread(app.state.cpu_converter_executor.shutdown, wait=True),
            timeout=30.0,
        )
    except asyncio.TimeoutError:
        import logging as _log
        _log.getLogger(__name__).warning(
            "CPU executor did not shut down within 30 s — forcing cancel"
        )
        app.state.cpu_converter_executor.shutdown(wait=False, cancel_futures=True)
    for _ex in app.state.retired_executors:
        try:
            _ex.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
    app.state.retired_executors.clear()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="PDF to Markdown API",
        description="PDF to Markdown conversion and text chunking service.",
        version=settings.APP_VERSION,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(documents_router)
    app.include_router(chunks_router)
    app.include_router(capabilities_router)
    app.include_router(enrichment_router)

    return app


app = create_app()
