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
    """Splitting strategy.

    Strategies shared by both LangChain and Chonkie:
        token, recursive, character, markdown

    Chonkie-only strategies (ignored by LangChainSplitter):
        sentence   → SentenceChunker
        fast       → FastChunker
        semantic   → SemanticChunker  (requires chonkie[semantic])
        late       → LateChunker      (requires chonkie[st])
        neural     → NeuralChunker    (requires chonkie[neural])
        slumber    → SlumberChunker   (requires chonkie[genie])
        table      → TableChunker
        code       → CodeChunker
    """

    # Shared
    token = "token"
    recursive = "recursive"
    character = "character"
    markdown = "markdown"

    # Chonkie-only
    sentence = "sentence"
    fast = "fast"
    semantic = "semantic"
    late = "late"
    neural = "neural"
    slumber = "slumber"
    table = "table"
    code = "code"


class SplitterLibrary(str, Enum):
    """Underlying splitting library to use."""

    langchain = "langchain"
    chonkie = "chonkie"


# ---------------------------------------------------------------------------
# VLM settings (only used when converter == vlm)
# ---------------------------------------------------------------------------


class VLMSettings(BaseModel):
    """Optional overrides for the VLM converter."""

    model: Optional[str] = Field(default=None)
    base_url: Optional[str] = Field(default=None)
    api_key: Optional[str] = Field(default=None)


# ---------------------------------------------------------------------------
# Document endpoints
# ---------------------------------------------------------------------------


class ConvertRequest(BaseModel):
    converter: ConverterType = Field(default=ConverterType.pymupdf)
    vlm: Optional[VLMSettings] = Field(default=None)


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
# Chunk endpoints — request
# ---------------------------------------------------------------------------


class ChunkRequest(BaseModel):
    """Body for POST /api/chunk."""

    content: str = Field(..., min_length=1, description="Text content to split.")
    splitter_type: SplitterType = Field(
        default=SplitterType.token,
        description="Splitting strategy.",
    )
    splitter_library: SplitterLibrary = Field(
        default=SplitterLibrary.langchain,
        description="Underlying splitting library to use.",
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


# ---------------------------------------------------------------------------
# Chunk item — enriched format
# ---------------------------------------------------------------------------


class ChunkItem(BaseModel):
    index: int
    content: str
    cleaned_chunk: str = Field(default="")
    title: str = Field(default="")
    context: str = Field(default="")
    summary: str = Field(default="")
    keywords: List[str] = Field(default_factory=list)
    questions: List[str] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    start: int = 0
    end: int = 0


class ChunkResponse(BaseModel):
    chunks: List[ChunkItem]
    total_chunks: int
    splitter_type: str
    splitter_library: str


# ---------------------------------------------------------------------------
# Chunk storage endpoints
# ---------------------------------------------------------------------------


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