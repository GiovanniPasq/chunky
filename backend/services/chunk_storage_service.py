"""
Chunk storage service — persists and loads chunk sets to/from disk.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from fastapi import HTTPException

from backend.models.schemas import LoadChunksResponse, SaveChunksRequest, SaveChunksResponse

CHUNKS_DIR = Path("chunks")


class ChunkStorageService:
    """Saves chunk sets as timestamped JSON files and retrieves the latest one."""

    def save_chunks(self, request: SaveChunksRequest) -> SaveChunksResponse:
        """Persist chunks to a new timestamped JSON file.

        Storage path::

            chunks/<stem>/<stem>_<UTC-ISO8601>.json

        The timestamp format (``YYYY-MM-DDTHH-MM-SSZ``) is filesystem-safe on
        all operating systems and sorts lexicographically in chronological order.

        Example::

            chunks/report/report_2024-05-10T14-32-07Z.json
        """
        stem = Path(request.filename).stem
        dest_dir = CHUNKS_DIR / stem
        dest_dir.mkdir(parents=True, exist_ok=True)

        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        dest_path = dest_dir / f"{stem}_{ts}.json"

        payload: Dict[str, Any] = {
            "filename": request.filename,
            "timestamp": ts,
            "total_chunks": len(request.chunks),
            "chunks": request.chunks,
        }

        dest_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return SaveChunksResponse(
            success=True,
            message=f"Saved {len(request.chunks)} chunks for '{request.filename}'",
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