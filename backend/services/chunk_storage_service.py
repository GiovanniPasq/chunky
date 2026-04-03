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
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from backend.config import get_settings
from backend.models.schemas import LoadChunksResponse, SaveChunksRequest, SaveChunksResponse

def _sanitise(value: str) -> str:
    """Replace non-alphanumeric characters with hyphens and collapse runs."""
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-zA-Z0-9]", "-", value)).strip("-")


def _to_api_schema(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a stored chunk (PascalCase keys) to the API / frontend schema (snake_case).

    Accepts both PascalCase (stored format) and snake_case (already-normalised)
    so the function is safe to call on any chunk dict regardless of its origin.
    """
    return {
        "index": raw.get("index", 0),
        "content": raw.get("Chunk", raw.get("content", "")),
        "cleaned_chunk": raw.get("CleanedChunk", raw.get("cleaned_chunk", "")),
        "title": raw.get("Title", raw.get("title", "")),
        "context": raw.get("Context", raw.get("context", "")),
        "summary": raw.get("Summary", raw.get("summary", "")),
        "keywords": raw.get("Keywords", raw.get("keywords", [])),
        "questions": raw.get("Questions", raw.get("questions", [])),
        "metadata": raw.get("metadata", {}),
        "start": raw.get("start", 0),
        "end": raw.get("end", 0),
    }


def _normalise_chunk(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure every chunk in the payload has all enrichment fields.

    Missing fields are filled with their zero-value defaults so that the
    stored JSON always conforms to the enriched schema, regardless of whether
    the chunk was produced before or after the enrichment pipeline runs.
    """
    return {
        "index": raw.get("index", 0),
        "Chunk": raw.get("content", raw.get("Chunk", "")),
        "CleanedChunk": raw.get("cleaned_chunk", raw.get("CleanedChunk", "")),
        "Title": raw.get("title", raw.get("Title", "")),
        "Context": raw.get("context", raw.get("Context", "")),
        "Summary": raw.get("summary", raw.get("Summary", "")),
        "Keywords": raw.get("keywords", raw.get("Keywords", [])),
        "Questions": raw.get("questions", raw.get("Questions", [])),
        # Preserve any extra metadata the splitter may have attached.
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
        stem = Path(request.filename).stem
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

        ts = datetime.now(tz=timezone.utc).strftime("%H-%M-%S")
        dest_path = dest_dir / f"{doc_name}_{chunk_type}_{ts}.json"

        normalised_chunks = [_normalise_chunk(c) for c in request.chunks]

        payload: Dict[str, Any] = {
            "filename": request.filename,
            "timestamp": ts,
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

        Because the timestamp portion of each filename is ISO-8601 with fixed
        width, lexicographic sort equals chronological sort — no date parsing
        required.

        Raises:
            HTTPException 404: If no saved chunks exist for this document.
        """
        stem = Path(filename).stem
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
            normalised = [_to_api_schema(c) for c in payload["chunks"]]
            return LoadChunksResponse(
                chunks=normalised,
                total_chunks=payload["total_chunks"],
                filename=payload["filename"],
            )
        except (json.JSONDecodeError, OSError) as exc:
            raise HTTPException(status_code=500, detail=f"Saved chunk file is corrupt: {exc}")
        except KeyError as exc:
            raise HTTPException(status_code=500, detail=f"Saved chunk file is missing field: {exc}")
