"""
Pydantic schemas for request / response models.
"""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Any

from backend.config import get_settings as _get_settings

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class ConverterType(str, Enum):
    pymupdf = "pymupdf"
    docling = "docling"
    markitdown = "markitdown"
    liteparse = "liteparse"
    vlm = "vlm"
    cloud = "cloud"


class ChunkerType(str, Enum):
    """Chunking strategy.

    Strategies shared by both LangChain and Chonkie:
        token, recursive, character, markdown

    Chonkie-only strategies:
        sentence   → SentenceChunker
        fast       → FastChunker
        semantic   → SemanticChunker  (requires chonkie[semantic])
        neural     → NeuralChunker    (requires chonkie[neural])
        table      → TableChunker
        code       → CodeChunker

    Docling-only strategies:
        hybrid     → HybridChunker
        line_based → LineBasedTokenChunker
    """

    # Shared
    token = "token"
    recursive = "recursive"

    #LangChain-only
    markdown = "markdown"
    character = "character"

    # Chonkie-only
    sentence = "sentence"
    fast = "fast"
    semantic = "semantic"
    neural = "neural"
    table = "table"
    code = "code"

    # Docling-only
    hybrid = "hybrid"
    line_based = "line_based"


class ChunkerLibrary(str, Enum):
    """Underlying chunking library to use."""

    langchain = "langchain"
    chonkie = "chonkie"
    docling = "docling"


# ---------------------------------------------------------------------------
# VLM settings (only used when converter == vlm)
# ---------------------------------------------------------------------------


class VLMSettings(BaseModel):
    """Optional overrides for the VLM converter."""

    model: str | None = Field(default=None)
    base_url: str | None = Field(default=None)
    api_key: str | None = Field(default=None)
    temperature: float | None = Field(default=None)
    user_prompt: str | None = Field(default=None)


# ---------------------------------------------------------------------------
# Cloud settings (only used when converter == cloud)
# ---------------------------------------------------------------------------


class CloudSettings(BaseModel):
    """Settings for the Cloud converter."""

    base_url: str | None = Field(default=None)
    bearer_token: str | None = Field(default=None)


# ---------------------------------------------------------------------------
# Document endpoints
# ---------------------------------------------------------------------------


class ConvertRequest(BaseModel):
    """Body for POST /api/convert."""

    filenames: list[str] = Field(..., min_length=1, description="PDF filename(s) to convert.")
    converter: ConverterType = Field(default=ConverterType.pymupdf)
    vlm: VLMSettings | None = Field(default=None)
    cloud: CloudSettings | None = Field(default=None)


class DocumentInfo(BaseModel):
    pdf_filename: str
    md_filename: str
    md_content: str
    has_markdown: bool
    has_pdf: bool = True


class MdToPdfResponse(BaseModel):
    success: bool
    pdf_filename: str
    message: str


class UploadFileResult(BaseModel):
    filename: str
    success: bool
    message: str


class MultiUploadResponse(BaseModel):
    uploaded: int
    failed: int
    results: list[UploadFileResult]


class ConvertResponse(BaseModel):
    success: bool
    md_filename: str
    message: str
    md_content: str


class DeleteResponse(BaseModel):
    success: bool
    deleted: list[str]
    message: str


# ---------------------------------------------------------------------------
# Chunk endpoints — request
# ---------------------------------------------------------------------------


class ChunkRequest(BaseModel):
    """Internal chunking request used by chunkers and worker processes."""

    content: str = Field(..., min_length=1, max_length=10_000_000, description="Text content to chunk.")
    chunker_type: ChunkerType = Field(default=ChunkerType.token)
    chunker_library: ChunkerLibrary = Field(default=ChunkerLibrary.langchain)
    chunk_size: int = Field(default=512, gt=0)
    chunk_overlap: int = Field(default=51, ge=0)
    enable_markdown_sizing: bool = Field(default=False)

    @field_validator("chunk_overlap")
    @classmethod
    def overlap_smaller_than_size(cls, v: int, info) -> int:
        chunk_size = info.data.get("chunk_size")
        if chunk_size is not None and v >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")
        return v


class ChunkFilesRequest(BaseModel):
    """Body for POST /api/chunk — one or more documents to chunk from disk."""

    filenames: list[str] = Field(..., min_length=1, description="Document filename(s) to chunk.")
    chunker_type: ChunkerType = Field(
        default=ChunkerType.token,
        description="Splitting strategy.",
    )
    chunker_library: ChunkerLibrary = Field(
        default=ChunkerLibrary.langchain,
        description="Underlying splitting library to use.",
    )
    chunk_size: int = Field(default=512, gt=0, description="Maximum chunk size.")
    chunk_overlap: int = Field(default=51, ge=0, description="Overlap between chunks.")
    enable_markdown_sizing: bool = Field(
        default=False,
        description=(
            "When chunker_type == 'markdown', apply a secondary size-based split "
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
    keywords: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    start: int = 0
    end: int = 0


class ChunkResponse(BaseModel):
    chunks: list[ChunkItem]
    total_chunks: int
    chunker_type: str
    chunker_library: str


# ---------------------------------------------------------------------------
# Chunk storage endpoints
# ---------------------------------------------------------------------------


class SaveChunksRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    chunks: list[dict[str, Any]]
    chunker_type: str | None = Field(default=None)
    chunker_library: str | None = Field(default=None)


class SaveChunksResponse(BaseModel):
    success: bool
    message: str
    path: str


class LoadChunksResponse(BaseModel):
    chunks: list[dict[str, Any]]
    total_chunks: int
    filename: str


# ---------------------------------------------------------------------------
# Enrichment endpoints
# ---------------------------------------------------------------------------


class EnrichmentRequest(BaseModel):
    """OpenAI-compatible connection settings for enrichment."""

    model: str
    base_url: str = Field(default_factory=lambda: _get_settings().ENRICHMENT_DEFAULT_BASE_URL)
    api_key: str = Field(default_factory=lambda: _get_settings().ENRICHMENT_DEFAULT_API_KEY)
    temperature: float = Field(default_factory=lambda: _get_settings().ENRICHMENT_DEFAULT_TEMPERATURE)
    user_prompt: str | None = None


class EnrichMarkdownRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=10_000_000)
    settings: EnrichmentRequest


class ChunkToEnrich(BaseModel):
    index: int
    content: str
    start: int = 0
    end: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


class EnrichChunksRequest(BaseModel):
    chunks: list[ChunkToEnrich] = Field(..., min_length=1)
    settings: EnrichmentRequest
