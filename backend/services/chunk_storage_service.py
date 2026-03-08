import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any

from fastapi import HTTPException

from backend.models.schemas import SaveChunksRequest, SaveChunksResponse, LoadChunksResponse

CHUNKS_DIR = Path("chunks")


class ChunkStorageService:

    def save_chunks(self, request: SaveChunksRequest) -> SaveChunksResponse:
        """
        Persist chunks as a timestamped JSON file.

        Path pattern:
            chunks/<filename_base>/<filename_base>_<UTC-ISO-timestamp>.json

        The timestamp is UTC ISO-8601 with seconds precision, colons replaced
        by hyphens so the name is filesystem-safe on every OS.
        Example: chunks/report/report_2024-05-10T14-32-07Z.json
        """
        filename_base = Path(request.filename).stem
        dest_dir = CHUNKS_DIR / filename_base
        dest_dir.mkdir(parents=True, exist_ok=True)

        ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
        chunks_path = dest_dir / f"{filename_base}_{ts}.json"

        payload: Dict[str, Any] = {
            "filename": request.filename,
            "timestamp": ts,
            "total_chunks": len(request.chunks),
            "chunks": request.chunks,
        }

        chunks_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return SaveChunksResponse(
            success=True,
            message=f"Saved {len(request.chunks)} chunks",
            path=str(chunks_path),
        )

    def load_chunks(self, filename: str) -> LoadChunksResponse:
        """
        Load the *most recent* saved chunk file for the given document.

        Files are sorted lexicographically; because the timestamp format is
        ISO-8601, lexicographic order equals chronological order.
        """
        filename_base = Path(filename).stem
        dest_dir = CHUNKS_DIR / filename_base

        if not dest_dir.exists():
            raise HTTPException(status_code=404, detail="No saved chunks found")

        json_files = sorted(dest_dir.glob("*.json"))
        if not json_files:
            raise HTTPException(status_code=404, detail="No saved chunks found")

        latest = json_files[-1]
        payload = json.loads(latest.read_text(encoding="utf-8"))

        return LoadChunksResponse(
            chunks=payload["chunks"],
            total_chunks=payload["total_chunks"],
            filename=payload["filename"],
        )
