from fastapi import APIRouter

from backend.models.schemas import (
    ChunkRequest,
    ChunkResponse,
    SaveChunksRequest,
    SaveChunksResponse,
    LoadChunksResponse,
)
from backend.services.chunk_storage_service import ChunkStorageService
from backend.services.chunking_service import ChunkingService

router = APIRouter(prefix="/api", tags=["chunks"])
_chunking = ChunkingService()
_storage = ChunkStorageService()


@router.post("/chunk", response_model=ChunkResponse)
async def chunk_text(request: ChunkRequest):
    """Split text into chunks using the specified strategy."""
    return _chunking.chunk_text(request)


@router.post("/chunks/save", response_model=SaveChunksResponse)
async def save_chunks(request: SaveChunksRequest):
    """Persist chunks to a timestamped JSON file on disk."""
    return _storage.save_chunks(request)


@router.get("/chunks/load/{filename}", response_model=LoadChunksResponse)
async def load_chunks(filename: str):
    """Load the most recent saved chunks for a document."""
    return _storage.load_chunks(filename)
