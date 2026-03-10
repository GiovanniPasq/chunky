"""
Chunky — PDF to Markdown & chunking API.
Entry point: uvicorn backend.main:app --reload
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.documents_router import router as documents_router
from backend.routers.chunks_router import router as chunks_router

ALLOWED_ORIGINS = [
    "http://localhost:5173",  # Vite dev server
    "http://localhost:3000",  # CRA / alternate dev server
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Future: initialise DB connections, warm up models, etc.
    yield
    # Future: clean up resources on shutdown


def create_app() -> FastAPI:
    app = FastAPI(
        title="Chunky API",
        description="PDF to Markdown conversion and text chunking service.",
        version="1.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(documents_router)
    app.include_router(chunks_router)

    @app.get("/", tags=["health"])
    async def health_check():
        """Basic liveness probe."""
        return {"status": "ok", "service": "Chunky API"}

    return app


app = create_app()