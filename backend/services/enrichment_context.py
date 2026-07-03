"""Shared loading helpers for enrichment endpoints."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import HTTPException

from backend.models.schemas import EnrichmentRequest
from backend.services.document_summary import DocumentSummary, DocumentSummaryStore
from backend.services.enrichment_service import EnrichmentService
from backend.services.document_files import document_stem_for_markdown
from backend.utils.path import safe_child_path, safe_filename

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class MarkdownSource:
    name: str
    stem: str
    content: str
    path: Path


@dataclass(frozen=True, slots=True)
class ChunkEnrichmentContext:
    md_name: str | None
    source_markdown: str
    document_summary: DocumentSummary | None


def build_enrichment_service(
    settings: EnrichmentRequest,
    http_client: httpx.AsyncClient,
) -> EnrichmentService:
    """Create the OpenAI-compatible enrichment service from request settings."""
    return EnrichmentService(
        model=settings.model,
        base_url=settings.base_url,
        api_key=settings.api_key,
        temperature=settings.temperature,
        user_prompt=settings.user_prompt,
        http_client=http_client,
    )


def load_markdown_source(
    *,
    mds_dir: Path,
    filename: str,
    empty_action: str,
    document_name: str | None = None,
) -> MarkdownSource:
    """Validate and load a stored Markdown file for an enrichment flow."""
    md_name = safe_filename(filename, "Markdown filename")
    md_path = safe_child_path(mds_dir, md_name, description="Markdown filename")
    if not md_path.exists():
        raise HTTPException(status_code=404, detail=f"Markdown file '{md_name}' not found")

    try:
        source_markdown = md_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not read '{md_name}': {exc}") from exc

    if not source_markdown.strip():
        raise HTTPException(status_code=422, detail=f"'{md_name}' is empty — nothing to {empty_action}")

    try:
        owner_stem = document_stem_for_markdown(document_name, md_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return MarkdownSource(
        name=md_name,
        stem=owner_stem,
        content=source_markdown,
        path=md_path,
    )


def load_cached_summary_for_markdown(
    *,
    mds_dir: Path,
    md_name: str,
    document_name: str | None = None,
    include_empty: bool = False,
) -> DocumentSummary | None:
    """Return the cached per-document summary for a Markdown variant, if any."""
    try:
        owner_stem = document_stem_for_markdown(document_name, md_name)
    except ValueError:
        return None
    stored = DocumentSummaryStore(owner_stem, mds_dir).load()
    if stored is None:
        return None
    if not include_empty and stored.summary.is_empty():
        return None
    return stored.summary


def load_chunk_enrichment_context(
    *,
    mds_dir: Path,
    md_filename: str | None,
    document_name: str | None = None,
) -> ChunkEnrichmentContext:
    """Best-effort context loading for chunk enrichment.

    Chunk enrichment should degrade gracefully: a bad optional markdown filename
    or unreadable source file should not abort enrichment of the provided chunks.
    """
    if not md_filename:
        return ChunkEnrichmentContext(md_name=None, source_markdown="", document_summary=None)

    try:
        md_name = safe_filename(md_filename, "Markdown filename")
        document_summary = load_cached_summary_for_markdown(
            mds_dir=mds_dir,
            md_name=md_name,
            document_name=document_name,
        )
    except Exception as exc:  # noqa: BLE001 - optional context must not abort chunk enrichment.
        logger.warning(
            "Chunk enrichment: failed to load summary for %r — continuing without: %s",
            md_filename,
            exc,
        )
        return ChunkEnrichmentContext(md_name=None, source_markdown="", document_summary=None)

    source_markdown = ""
    try:
        md_path = safe_child_path(mds_dir, md_name, description="Markdown filename")
        if md_path.is_file():
            source_markdown = md_path.read_text(encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 - optional context must not abort chunk enrichment.
        logger.warning(
            "Chunk enrichment: failed to load source markdown for %r — continuing without surrounding context: %s",
            md_filename,
            exc,
        )

    return ChunkEnrichmentContext(
        md_name=md_name,
        source_markdown=source_markdown,
        document_summary=document_summary,
    )
