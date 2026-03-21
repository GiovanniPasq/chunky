"""
PDF to Markdown & chunking API.
Entry point: uvicorn backend.main:app --reload
"""

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

    yield

    await app.state.http_client_async.aclose()
    app.state.http_client_sync.close()


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
