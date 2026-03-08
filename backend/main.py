from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routers.documents_router import router as documents_router
from backend.routers.chunks_router import router as chunks_router

ALLOWED_ORIGINS = [
    "http://localhost:5173",  # Vite
    "http://localhost:3000",  # CRA
]


def create_app() -> FastAPI:
    app = FastAPI(title="PDF Visualizer API")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(documents_router)
    app.include_router(chunks_router)

    @app.get("/")
    async def root():
        return {"message": "PDF Visualizer API"}

    return app


app = create_app()
