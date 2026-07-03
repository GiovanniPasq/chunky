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
        token, recursive

    LangChain-only strategies:
        character, markdown

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

    # LangChain-only
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
    use_checkpoint: bool = Field(
        default=True,
        description=(
            "When true, resume from per-page checkpoints saved by a previous "
            "interrupted conversion (if any). When false, discard any existing "
            "checkpoint and reconvert from page 1."
        ),
    )


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
    force: bool = Field(
        default=False,
        description="When true, replace an existing Markdown variant instead of reusing it.",
    )
    vlm: VLMSettings | None = Field(default=None)
    cloud: CloudSettings | None = Field(default=None)


class ConvertPreviewRequest(BaseModel):
    """Body for POST /api/convert/preview."""

    filename: str = Field(..., min_length=1, description="PDF filename to preview.")
    converter: ConverterType = Field(default=ConverterType.pymupdf)
    start_page: int = Field(default=1, ge=1, description="1-indexed first page to include.")
    end_page: int = Field(default=1, ge=1, description="1-indexed last page to include.")
    preview_id: str | None = Field(
        default=None,
        description="Optional client-generated id used to explicitly cancel an in-flight preview.",
    )
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
    failed_pages: list[int] | None = Field(
        default=None,
        description=(
            "1-indexed page numbers that could not be transcribed. Populated "
            "only by the VLM converter; null for converters that cannot "
            "report per-page failures."
        ),
    )
    resumed_pages: int | None = Field(
        default=None,
        description=(
            "Number of pages that were loaded from the checkpoint at the "
            "start of this conversion (i.e. skipped both the rendering and "
            "the API call). Null when checkpointing is not applicable to "
            "the converter."
        ),
    )


class ConvertPreviewResponse(BaseModel):
    success: bool = True
    filename: str
    converter: ConverterType
    start_page: int
    end_page: int
    page_count: int
    md_content: str


class DeleteResponse(BaseModel):
    success: bool
    deleted: list[str]
    deleted_documents: list[str] = Field(default_factory=list)
    failed: dict[str, str] = Field(default_factory=dict)
    message: str


# ---------------------------------------------------------------------------
# Chunk endpoints — request
# ---------------------------------------------------------------------------


class ChunkRequest(BaseModel):
    """Internal chunking request used by chunkers and worker processes."""

    content: str = Field(..., min_length=1, max_length=10_000_000, description="Text content to chunk.")
    chunker_type: ChunkerType = Field(default=ChunkerType.token)
    chunker_library: ChunkerLibrary = Field(default=ChunkerLibrary.langchain)
    chunk_size: int = Field(default_factory=lambda: _get_settings().DEFAULT_CHUNK_SIZE, gt=0)
    chunk_overlap: int = Field(default_factory=lambda: _get_settings().DEFAULT_CHUNK_OVERLAP, ge=0)
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
    md_filename: str | None = Field(
        default=None,
        description=(
            "Specific Markdown variant to chunk (e.g. 'report_pymupdf4llm.md'). "
            "When omitted, the first available variant is used.  Only meaningful "
            "for single-document requests; ignored when multiple filenames are sent."
        ),
    )
    chunker_type: ChunkerType = Field(
        default=ChunkerType.token,
        description="Splitting strategy.",
    )
    chunker_library: ChunkerLibrary = Field(
        default=ChunkerLibrary.langchain,
        description="Underlying splitting library to use.",
    )
    chunk_size: int = Field(
        default_factory=lambda: _get_settings().DEFAULT_CHUNK_SIZE,
        gt=0,
        description="Strategy-specific size target; ignored by Chonkie Table and Neural.",
    )
    chunk_overlap: int = Field(
        default_factory=lambda: _get_settings().DEFAULT_CHUNK_OVERLAP,
        ge=0,
        description="Requested overlap; unsupported strategies ignore it.",
    )
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
    source_hash: str | None = None


# ---------------------------------------------------------------------------
# Chunk storage endpoints
# ---------------------------------------------------------------------------


class SaveChunksRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    md_filename: str | None = Field(
        default=None,
        description="The Markdown filename the chunks were generated from "
                    "(e.g. 'report_pymupdf4llm.md').  Encoded into the saved "
                    "chunk filename so chunks from different MD variants "
                    "stay distinguishable.",
    )
    source_hash: str | None = Field(
        default=None,
        description="SHA-256 of the Markdown content that produced these chunks.",
    )
    chunks: list[dict[str, Any]]
    chunker_type: str | None = Field(default=None)
    chunker_library: str | None = Field(default=None)
    chunk_size: int | None = Field(default=None)
    chunk_overlap: int | None = Field(default=None)
    enable_markdown_sizing: bool = Field(default=False)


class SaveChunksResponse(BaseModel):
    success: bool
    message: str
    path: str


class LoadChunksResponse(BaseModel):
    chunks: list[dict[str, Any]]
    total_chunks: int
    filename: str
    source_hash: str | None = None


# ---------------------------------------------------------------------------
# Versioned markdowns / chunks endpoints
# ---------------------------------------------------------------------------


class MarkdownVersion(BaseModel):
    """A single available Markdown version for a document.

    ``source`` distinguishes between Markdown produced by an internal
    PDF→MD conversion (``"converted"``) and Markdown the user uploaded
    directly (``"uploaded"``).  ``converter`` is populated only when
    ``source == "converted"``.
    """

    filename: str
    source: str = Field(..., description='Either "converted" or "uploaded".')
    converter: str | None = Field(
        default=None,
        description="Normalised converter name when source is 'converted'.",
    )
    has_failures: bool = Field(
        default=False,
        description=(
            "True when this variant's content contains one or more "
            "``<!-- page N failed: … -->`` placeholders left by the VLM "
            "converter after a partial run.  Used by the UI to mark the "
            "specific variant in the version picker."
        ),
    )


class MarkdownVersionsResponse(BaseModel):
    document_name: str
    versions: list[MarkdownVersion]


class MarkdownContentResponse(BaseModel):
    filename: str
    source: str
    converter: str | None = None
    content: str


class SaveMarkdownRequest(BaseModel):
    content: str = Field(..., max_length=10_000_000)


class CheckpointInfoResponse(BaseModel):
    """Per-document checkpoint state, surfaced to the UI so it can show a
    "Resume available" indicator before the user kicks off a conversion."""

    document_name: str
    converter: str = Field(default="vlm", description="Converter token the checkpoint belongs to.")
    exists: bool = Field(description="True when at least one cached page is on disk.")
    completed_pages: list[int] = Field(
        default_factory=list,
        description="Sorted 1-indexed list of page numbers already cached on disk.",
    )


class ChunksVersion(BaseModel):
    """A single saved chunks JSON file for a document.

    Each saved file is keyed by its splitting *configuration* — library,
    algorithm, and (when applicable) chunk size and overlap — so the same
    configuration always overwrites the same file.  Fields not used by the
    underlying algorithm (e.g. overlap for Docling) are reported as
    ``null``.
    """

    filename: str
    md_filename: str | None = Field(
        default=None,
        description="Source Markdown filename the chunks were generated from, "
                    "parsed from the chunk filename when available.",
    )
    md_source: str | None = Field(
        default=None,
        description="Short token identifying the source MD variant "
                    "(converter name like 'pymupdf4llm', or 'uploaded').",
    )
    library: str = Field(..., description="Library name parsed from the filename.")
    algorithm: str = Field(..., description="Algorithm name parsed from the filename.")
    chunk_size: int | None = Field(
        default=None,
        description="Chunk size encoded in the filename, or null when the algorithm doesn't use it.",
    )
    chunk_overlap: int | None = Field(
        default=None,
        description="Chunk overlap encoded in the filename, or null when the algorithm doesn't use it.",
    )
    source_hash: str | None = Field(
        default=None,
        description="SHA-256 of the Markdown bytes used to generate this saved chunk set.",
    )
    is_stale: bool = Field(
        default=True,
        description="True when the saved source hash is missing or differs from the current Markdown.",
    )


class ChunksVersionsResponse(BaseModel):
    document_name: str
    versions: list[ChunksVersion]


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


class EnrichPipelineRequest(BaseModel):
    """Body for POST /api/enrich/markdown/pipeline.

    Drives the full regex-cleanup → structure-aware-split → per-piece-LLM
    pipeline (see :mod:`backend.services.enrichment_pipeline`). ``filename``
    must reference a stored Markdown file; the pipeline reads its source
    content from disk.
    """

    filename: str = Field(..., description="Stored markdown filename (e.g. 'report_vlm.md').")
    document_name: str | None = Field(
        default=None,
        description="Owning PDF or standalone Markdown document name.",
    )
    settings: EnrichmentRequest
    use_checkpoint: bool = Field(
        default=True,
        description=(
            "When true, resume from any cached pieces left by a previous "
            "pipeline run.  When false, discard the cache and reconvert "
            "every piece from scratch."
        ),
    )
    use_summary: bool = Field(
        default=True,
        description=(
            "When true (default), attach any cached document-level summary "
            "to every piece prompt.  When false, ignore the cached "
            "summary for this run — equivalent to running enrichment "
            "without a summary.  Used by the SummaryReviewModal's Skip "
            "button and by the Settings → Skip document summary "
            "preference to opt out of document-level context."
        ),
    )


class ChunkToEnrich(BaseModel):
    index: int
    content: str
    start: int = 0
    end: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


class EnrichChunksRequest(BaseModel):
    chunks: list[ChunkToEnrich] = Field(..., min_length=1)
    settings: EnrichmentRequest
    document_name: str | None = Field(
        default=None,
        description="Owning PDF or standalone Markdown document name.",
    )
    md_filename: str | None = Field(
        default=None,
        description=(
            "Optional markdown variant filename (e.g. 'report_vlm.md'). "
            "When provided AND a document-level summary exists on disk "
            "for the owning document, that summary is attached to "
            "every chunk-enrichment prompt as document-level context. "
            "Absent: chunk enrichment runs without context (the prior "
            "behaviour).  Chunk enrichment never generates a summary "
            "itself — that happens in the markdown enrichment flow's "
            "review modal."
        ),
    )


# ---------------------------------------------------------------------------
# Document-summary endpoints
# ---------------------------------------------------------------------------


class DocumentSummaryPayload(BaseModel):
    """Wire-level shape of a :class:`DocumentSummary` (see
    :mod:`backend.services.document_summary`).

    Minimal — only ``topic`` and ``narrative``.  Field names match the
    dataclass and the on-disk JSON so the frontend stores what it
    receives without translation.
    """

    topic: str = ""
    narrative: str = ""


class DocumentSummaryStatus(BaseModel):
    """Metadata surfaced alongside the summary content."""

    user_edited: bool
    generated_at: str


class DocumentSummaryResponse(BaseModel):
    """Body of ``GET /api/enrich/summary`` and the ``done`` event of
    ``POST /api/enrich/summary/generate``."""

    filename: str
    doc_stem: str
    summary: DocumentSummaryPayload
    status: DocumentSummaryStatus


class SummaryGenerateRequest(BaseModel):
    """Body of ``POST /api/enrich/summary/generate``.

    ``force`` discards any cached record before generation so the modal's
    Regenerate button produces a fresh summary even when one already
    exists.  When ``force`` is false, an existing record (even an old
    LLM-generated one) is returned as a fast path and no LLM calls are
    made.
    """

    filename: str = Field(..., description="Stored markdown filename (e.g. 'report_vlm.md').")
    document_name: str | None = Field(
        default=None,
        description="Owning PDF or standalone Markdown document name.",
    )
    settings: EnrichmentRequest
    force: bool = Field(default=False)


class SummaryUpdateRequest(BaseModel):
    """Body of ``PUT /api/enrich/summary``.

    Persists the user-edited summary with ``user_edited=True`` so future
    enrichment runs treat the edit as authoritative. Source-hash metadata
    is carried over from the existing record.
    """

    filename: str = Field(..., description="Stored markdown filename (e.g. 'report_vlm.md').")
    document_name: str | None = Field(
        default=None,
        description="Owning PDF or standalone Markdown document name.",
    )
    summary: DocumentSummaryPayload
