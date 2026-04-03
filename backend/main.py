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

# Shared httpx timeout applied to every external LLM API call.
_HTTPX_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=5.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(level=settings.LOG_LEVEL, fmt=settings.LOG_FORMAT)

    # One shared connection pool for async callers (enrichment service).
    app.state.http_client_async = httpx.AsyncClient(timeout=_HTTPX_TIMEOUT)
    # One shared connection pool for sync callers running in thread-pool (VLM converter).
    app.state.http_client_sync = httpx.Client(timeout=_HTTPX_TIMEOUT)

    # Semaphore that caps total concurrent conversions across all requests.
    # Created here (not lazily in the router) so there is exactly one instance
    # bound to the running event loop — avoiding the race where two concurrent
    # requests both see _semaphore is None and create separate semaphores.
    app.state.conversion_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CONVERSIONS)

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

    yield

    await app.state.http_client_async.aclose()
    app.state.http_client_sync.close()
    app.state.cpu_converter_executor.shutdown(wait=True)


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
