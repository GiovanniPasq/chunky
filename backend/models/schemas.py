"""
Pydantic schemas for request / response models.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ConverterType(str, Enum):
    pymupdf = "pymupdf"
    docling = "docling"
    markitdown = "markitdown"
    vlm = "vlm"


class SplitterType(str, Enum):
    token = "token"
    recursive = "recursive"
    character = "character"
    markdown = "markdown"


# ---------------------------------------------------------------------------
# VLM settings (only used when converter == vlm)
# ---------------------------------------------------------------------------


class VLMSettings(BaseModel):
    """Optional overrides for the VLM converter.

    All fields are optional; omitted fields fall back to VLMConverter defaults
    (Ollama running locally with llama3.2-vision).
    """

    model: Optional[str] = Field(
        default=None,
        description="Model identifier (e.g. 'llama3.2-vision', 'gpt-4o', 'gemini-2.5-flash').",
    )
    base_url: Optional[str] = Field(
        default=None,
        description=(
            "OpenAI-compatible API base URL. "
            "Defaults to http://localhost:11434/v1 (Ollama)."
        ),
    )
    api_key: Optional[str] = Field(
        default=None,
        description="API key. Any non-empty string works for Ollama.",
    )


# ---------------------------------------------------------------------------
# Document endpoints
# ---------------------------------------------------------------------------


class ConvertRequest(BaseModel):
    """Body for POST /api/convert/{filename}."""

    converter: ConverterType = Field(
        default=ConverterType.pymupdf,
        description="Conversion engine to use.",
    )
    vlm: Optional[VLMSettings] = Field(
        default=None,
        description="VLM-specific settings. Ignored unless converter == 'vlm'.",
    )


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


# ---------------------------------------------------------------------------
# Chunk endpoints
# ---------------------------------------------------------------------------


class ChunkRequest(BaseModel):
    """Body for POST /api/chunk."""

    content: str = Field(..., min_length=1, description="Text content to split.")
    splitter_type: SplitterType = Field(
        default=SplitterType.token,
        description="Splitting strategy.",
    )
    chunk_size: int = Field(default=512, gt=0, description="Maximum chunk size.")
    chunk_overlap: int = Field(default=51, ge=0, description="Overlap between chunks.")
    enable_markdown_sizing: bool = Field(
        default=False,
        description=(
            "When splitter_type == 'markdown', apply a secondary size-based split "
            "to cap each section at chunk_size characters."
        ),
    )

    @field_validator("chunk_overlap")
    @classmethod
    def overlap_smaller_than_size(cls, v: int, info) -> int:
        chunk_size = info.data.get("chunk_size")
        if chunk_size is not None and v >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        return v


class ChunkItem(BaseModel):
    index: int
    content: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    start: int = 0
    end: int = 0


class ChunkResponse(BaseModel):
    chunks: List[ChunkItem]
    total_chunks: int
    splitter_type: str


class SaveChunksRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    chunks: List[Dict[str, Any]]


class SaveChunksResponse(BaseModel):
    success: bool
    message: str
    path: str


class LoadChunksResponse(BaseModel):
    chunks: List[Dict[str, Any]]
    total_chunks: int
    filename: str