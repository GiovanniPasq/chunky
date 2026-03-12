"""
Chunk storage service — persists and loads enriched chunk sets to/from disk.

Each chunk is stored with the full enriched schema:
    Chunk, CleanedChunk, Title, Context, Summary, Keywords, Questions.
Fields that have not yet been populated (pre-enrichment) are stored as empty
strings / empty lists and will be filled in by the enrichment pipeline later.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastapi import HTTPException

from backend.models.schemas import LoadChunksResponse, SaveChunksRequest, SaveChunksResponse

CHUNKS_DIR = Path("chunks")


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

    def save_chunks(self, request: SaveChunksRequest) -> SaveChunksResponse:
        """Persist chunks to a new timestamped JSON file.

        Storage path::

            chunks/<stem>/<stem>_<UTC-ISO8601>.json

        The timestamp format (``YYYY-MM-DDTHH-MM-SSZ``) is filesystem-safe on
        all operating systems and sorts lexicographically in chronological order.

        Example::

            chunks/report/report_2024-05-10T14-32-07Z.json

        Each chunk is normalised to the full enriched schema before writing,
        so the file is ready for the enrichment pipeline even if the chunks
        were produced before enrichment ran.
        """
        stem = Path(request.filename).stem
        dest_dir = CHUNKS_DIR / stem
        dest_dir.mkdir(parents=True, exist_ok=True)

        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        dest_path = dest_dir / f"{stem}_{ts}.json"

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
        dest_dir = CHUNKS_DIR / stem

        json_files = sorted(dest_dir.glob("*.json")) if dest_dir.exists() else []

        if not json_files:
            raise HTTPException(
                status_code=404,
                detail=f"No saved chunks found for '{filename}'",
            )

        payload = json.loads(json_files[-1].read_text(encoding="utf-8"))

        return LoadChunksResponse(
            chunks=payload["chunks"],
            total_chunks=payload["total_chunks"],
            filename=payload["filename"],
        )
