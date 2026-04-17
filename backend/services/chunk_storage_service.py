"""
Chunk storage service — persists and loads enriched chunk sets to/from disk.

Each chunk is stored with the full enriched schema:
    Chunk, CleanedChunk, Title, Context, Summary, Keywords, Questions.
Fields that have not yet been populated (pre-enrichment) are stored as empty
strings / empty lists and will be filled in by the enrichment pipeline later.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from backend.config import get_settings
from backend.models.schemas import LoadChunksResponse, SaveChunksRequest, SaveChunksResponse
from backend.utils.path import safe_stem as _safe_stem

def _sanitise(value: str) -> str:
    """Replace non-alphanumeric characters with hyphens and collapse runs."""
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-zA-Z0-9]", "-", value)).strip("-")


def _normalise_chunk(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalise a chunk dict to snake_case, filling missing enrichment fields.

    Accepts both snake_case and legacy PascalCase keys so the function is safe
    to call on incoming request data (write path) and on stored JSON (read path).
    This eliminates the old separate ``_to_api_schema`` / ``_normalise_chunk``
    pair that each did one half of the same bidirectional conversion.
    """
    return {
        "index": raw.get("index", 0),
        "content": raw.get("content", raw.get("Chunk", "")),
        "cleaned_chunk": raw.get("cleaned_chunk", raw.get("CleanedChunk", "")),
        "title": raw.get("title", raw.get("Title", "")),
        "context": raw.get("context", raw.get("Context", "")),
        "summary": raw.get("summary", raw.get("Summary", "")),
        "keywords": raw.get("keywords", raw.get("Keywords", [])),
        "questions": raw.get("questions", raw.get("Questions", [])),
        "metadata": raw.get("metadata", {}),
        "start": raw.get("start", 0),
        "end": raw.get("end", 0),
    }


class ChunkStorageService:
    """Saves enriched chunk sets as timestamped JSON files and retrieves the latest."""

    def __init__(self) -> None:
        self._chunks_dir = Path(get_settings().CHUNKS_DIR)

    def save_chunks(self, request: SaveChunksRequest) -> SaveChunksResponse:
        """Persist chunks to a new timestamped JSON file.

        Storage path::

            chunks/<stem>/<documentName>_<chunkType>_<HH-MM-SS>.json

        The ``<chunkType>`` is ``<library>-<splitter_type>`` when provided,
        otherwise ``chunks``.  The timestamp is ``HH-MM-SS`` in UTC.
        All components are sanitised (spaces and special characters replaced
        with hyphens) so the filename is safe on all operating systems.

        Examples::

            chunks/report/report_langchain-token_14-32-07.json
            chunks/report/report_chunks_09-05-41.json

        Each chunk is normalised to the full enriched schema before writing,
        so the file is ready for the enrichment pipeline even if the chunks
        were produced before enrichment ran.
        """
        stem = _safe_stem(request.filename)
        doc_name = _sanitise(stem) or "doc"
        dest_dir = self._chunks_dir / stem
        dest_dir.mkdir(parents=True, exist_ok=True)

        # Build the chunk-type segment from splitter info when available.
        if request.splitter_library and request.splitter_type:
            chunk_type = _sanitise(f"{request.splitter_library}-{request.splitter_type}")
        elif request.splitter_type:
            chunk_type = _sanitise(request.splitter_type)
        else:
            chunk_type = "chunks"

        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d_%H-%M-%S-%f")
        dest_path = dest_dir / f"{doc_name}_{chunk_type}_{ts}.json"

        normalised_chunks = [_normalise_chunk(c) for c in request.chunks]

        payload: dict[str, Any] = {
            "filename": request.filename,
            "timestamp": datetime.now(tz=timezone.utc).isoformat(),
            "total_chunks": len(normalised_chunks),
            "chunks": normalised_chunks,
        }

        dest_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return SaveChunksResponse(
            success=True,
            message=f"Saved {len(normalised_chunks)} chunks for '{request.filename}'",
            path=str(dest_path),
        )

    def load_chunks(self, filename: str) -> LoadChunksResponse:
        """Load the most recently saved chunk file for *filename*.

        Because the timestamp portion of each filename uses ISO-8601 date+time
        with fixed width (``YYYY-MM-DD_HH-MM-SS``), lexicographic sort equals
        chronological sort — no date parsing required.

        Raises:
            HTTPException 400: If *filename* is invalid or contains path traversal.
            HTTPException 404: If no saved chunks exist for this document.
        """
        stem = _safe_stem(filename)
        dest_dir = self._chunks_dir / stem

        try:
            json_files = sorted(dest_dir.glob("*.json"))
        except (FileNotFoundError, OSError):
            json_files = []

        if not json_files:
            raise HTTPException(
                status_code=404,
                detail=f"No saved chunks found for '{filename}'",
            )

        try:
            payload = json.loads(json_files[-1].read_text(encoding="utf-8"))
            normalised = [_normalise_chunk(c) for c in payload["chunks"]]
            return LoadChunksResponse(
                chunks=normalised,
                total_chunks=payload["total_chunks"],
                filename=payload["filename"],
            )
        except (json.JSONDecodeError, OSError) as exc:
            raise HTTPException(status_code=500, detail=f"Saved chunk file is corrupt: {exc}")
        except KeyError as exc:
            raise HTTPException(status_code=500, detail=f"Saved chunk file is missing field: {exc}")
