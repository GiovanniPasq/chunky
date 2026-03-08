from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional


class ChunkRequest(BaseModel):
    content: str
    splitter_type: str = Field(
        default="token",
        description="Splitter strategy: 'token', 'recursive', 'character', 'markdown'"
    )
    chunk_size: int = Field(default=512, gt=0)
    chunk_overlap: int = Field(default=51, ge=0)
    enable_markdown_sizing: bool = False


class ChunkItem(BaseModel):
    index: int
    content: str
    metadata: Dict[str, Any] = {}
    start: int = 0
    end: int = 0


class ChunkResponse(BaseModel):
    chunks: List[ChunkItem]
    total_chunks: int
    splitter_type: str


class SaveChunksRequest(BaseModel):
    filename: str
    chunks: List[Dict[str, Any]]


class SaveChunksResponse(BaseModel):
    success: bool
    message: str
    path: str


class LoadChunksResponse(BaseModel):
    chunks: List[Dict[str, Any]]
    total_chunks: int
    filename: str


class DocumentInfo(BaseModel):
    pdf_filename: str
    md_filename: str
    md_content: str
    has_markdown: bool


class UploadResponse(BaseModel):
    success: bool
    filename: str
    message: str


class UploadFileResult(BaseModel):
    filename: str
    success: bool
    message: str


class MultiUploadResponse(BaseModel):
    uploaded: int
    failed: int
    results: List[UploadFileResult]


class ConvertResponse(BaseModel):
    success: bool
    md_filename: str
    message: str
    md_content: str


class DeleteResponse(BaseModel):
    success: bool
    deleted: List[str]
    message: str