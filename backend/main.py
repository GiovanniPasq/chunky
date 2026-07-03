"""
PDF to Markdown & chunking API.
Entry point: uvicorn backend.main:app --reload
"""

import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import get_settings
from backend.logging_config import configure_logging
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
            write=settings.ENRICH_WRITE_TIMEOUT_S,
            pool=settings.HTTP_POOL_TIMEOUT_S,
        )
    )

    # Semaphore that caps total concurrent conversions across all requests.
    # Created here (not lazily in the router) so there is exactly one instance
    # bound to the running event loop — avoiding the race where two concurrent
    # requests both see _semaphore is None and create separate semaphores.
    app.state.conversion_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CONVERSIONS)

    # Global semaphore for chunk enrichment LLM calls across ALL concurrent requests.
    # Without this, each /enrich/chunks request creates its own semaphore, so
    # N simultaneous requests each get ENRICHMENT_MAX_CONCURRENT_CHUNKS slots —
    # the real concurrency would be N × ENRICHMENT_MAX_CONCURRENT_CHUNKS.
    app.state.enrichment_chunks_semaphore = asyncio.Semaphore(settings.ENRICHMENT_MAX_CONCURRENT_CHUNKS)

    app.state.chunk_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHUNKING)

    yield

    await app.state.http_client_async.aclose()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="Chunky API",
        description="Document conversion, Markdown enrichment, and text chunking service.",
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
