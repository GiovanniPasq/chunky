"""
Chunk storage service — persists and loads enriched chunk sets to/from disk.

Each chunk is stored with the full enriched schema:
    Chunk, CleanedChunk, Title, Context, Summary, Keywords, Questions.
Fields that have not yet been populated (pre-enrichment) are stored as empty
strings / empty lists and will be filled in by the enrichment pipeline later.

Filename format
---------------
Saved chunk files are addressable by *configuration*, not by time.  The path is::

    chunks/<stem>/<doc>_<md_source>_<library>-<algorithm>[_<size>[_<overlap>]].json

* ``<md_source>`` identifies the Markdown variant the chunks were generated
  from (``pymupdf4llm``, ``docling``, …, or ``uploaded``).  Without this
  segment, chunking the same PDF with different converters but the same
  algorithm would silently overwrite each other's saved files.
* The ``<library>-<algorithm>`` segment ALWAYS contains a hyphen so the
  parser can locate it unambiguously even when the document name itself
  contains underscores.  Wire-level chunker-type values that contain
  underscores (only ``line_based`` today) are rewritten with hyphens
  inside the filename.
* ``<size>`` and ``<overlap>`` are appended only when the chosen algorithm
  actually consumes them.

Re-saving with the same configuration overwrites in place.
"""

from __future__ import annotations

import json
import logging
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from backend.config import get_settings
from backend.services.document_files import document_stem_for_markdown
from backend.models.schemas import (
    ChunksVersion,
    LoadChunksResponse,
    SaveChunksRequest,
    SaveChunksResponse,
)
from backend.utils.naming import (
    KNOWN_LIBRARIES,
    KNOWN_MD_SOURCES,
    algo_from_filename_token,
    algo_to_filename_token,
    md_source_token,
    params_used_by,
    sanitise_token,
)
from backend.utils.path import safe_child_path, safe_stem as _safe_stem
from backend.utils.files import atomic_write_text

logger = logging.getLogger(__name__)


def _build_chunk_filename(
    doc_name: str,
    md_source: str,
    library: str | None,
    chunker_type: str | None,
    chunk_size: int | None,
    chunk_overlap: int | None,
    enable_markdown_sizing: bool,
) -> str:
    """Build the deterministic chunk-file name for a given configuration."""
    lib_token = sanitise_token((library or "unknown").lower()) or "unknown"
    algo_token = algo_to_filename_token(chunker_type or "unknown") or "unknown"
    libalgo = f"{lib_token}-{algo_token}"

    parts: list[str] = [doc_name, md_source or "uploaded", libalgo]
    uses_size, uses_overlap = params_used_by(library or "", chunker_type or "", enable_markdown_sizing)
    if uses_size and chunk_size is not None:
        parts.append(str(int(chunk_size)))
        if uses_overlap and chunk_overlap is not None:
            parts.append(str(int(chunk_overlap)))
    return "_".join(parts) + ".json"


def _parse_chunk_filename(
    filename: str,
) -> tuple[str | None, str, str, int | None, int | None]:
    """Extract ``(md_source, library, algorithm, chunk_size, chunk_overlap)``.

    The library/algorithm segment is identified as the first hyphenated token
    after splitting on ``_``, preferring tokens whose left side is a known
    library.  Anything that doesn't match falls back gracefully so listing
    is never bricked by a stray legacy file.
    """
    if not filename.endswith(".json"):
        return None, "unknown", "unknown", None, None
    tokens = filename[: -len(".json")].split("_")

    libalgo_idx: int | None = None
    for i, tok in enumerate(tokens):
        if "-" not in tok:
            continue
        if tok.split("-", 1)[0] in KNOWN_LIBRARIES:
            libalgo_idx = i
            break
    if libalgo_idx is None:
        for i, tok in enumerate(tokens):
            if "-" in tok:
                libalgo_idx = i
                break
    if libalgo_idx is None:
        return None, "unknown", "unknown", None, None

    library, _, algo_token = tokens[libalgo_idx].partition("-")
    algorithm = algo_from_filename_token(algo_token) if algo_token else "unknown"

    md_source: str | None = None
    if libalgo_idx >= 1 and tokens[libalgo_idx - 1] in KNOWN_MD_SOURCES:
        md_source = tokens[libalgo_idx - 1]

    rest = tokens[libalgo_idx + 1:]
    size = int(rest[0]) if len(rest) >= 1 and rest[0].isdigit() else None
    overlap = int(rest[1]) if len(rest) >= 2 and rest[1].isdigit() else None
    return md_source, library or "unknown", algorithm or "unknown", size, overlap


def _as_str(value: Any) -> str:
    return "" if value is None else str(value)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        item = value.strip()
        return [item] if item else []
    if isinstance(value, (list, tuple, set)):
        items: list[str] = []
        for raw in value:
            item = _as_str(raw).strip()
            if item:
                items.append(item)
        return items
    return []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalise_chunk(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalise a chunk dict to snake_case, filling missing enrichment fields.

    Accepts both snake_case and legacy PascalCase keys so the function is safe
    on incoming request data (write path) and on stored JSON (read path).
    """
    return {
        "index": _as_int(raw.get("index", 0)),
        "content": _as_str(raw.get("content", raw.get("Chunk", ""))),
        "cleaned_chunk": _as_str(raw.get("cleaned_chunk", raw.get("CleanedChunk", ""))),
        "title": _as_str(raw.get("title", raw.get("Title", ""))),
        "context": _as_str(raw.get("context", raw.get("Context", ""))),
        "summary": _as_str(raw.get("summary", raw.get("Summary", ""))),
        "keywords": _as_str_list(raw.get("keywords", raw.get("Keywords", []))),
        "questions": _as_str_list(raw.get("questions", raw.get("Questions", []))),
        "metadata": _as_dict(raw.get("metadata", {})),
        "start": _as_int(raw.get("start", 0)),
        "end": _as_int(raw.get("end", 0)),
    }


def _md_filename_for_source(stem: str, md_source: str | None) -> str | None:
    """Reconstruct the Markdown filename a chunk file was generated from.

    Saved chunk JSON only stores ``md_source`` (the identity key) — the full
    filename is computed on read so the on-disk payload stays minimal.
    """
    if md_source is None:
        return None
    if md_source == "uploaded":
        return f"{stem}.md"
    return f"{stem}_{md_source}.md"


def _sha256_markdown(path: Path) -> str | None:
    try:
        content = path.read_text(encoding="utf-8")
        return hashlib.sha256(content.encode("utf-8")).hexdigest()
    except OSError:
        return None


def delete_chunks_for_markdown(
    chunks_dir: Path,
    md_filename: str,
    *,
    document_name: str | None = None,
) -> list[Path]:
    """Delete saved chunk files generated from one Markdown variant.

    Chunk files are stored under the source document stem, even for converted
    Markdown variants (``chunks/report/...report_vlm...``).  Deleting
    ``report_vlm.md`` therefore must remove only ``md_source=vlm`` files from
    ``chunks/report`` while preserving chunks for sibling variants.
    """
    from backend.services.document_files import document_stem_for_markdown

    try:
        doc_stem = document_stem_for_markdown(document_name, md_filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    md_source = md_source_token(md_filename, doc_stem)
    dest_dir = chunks_dir / doc_stem
    if not dest_dir.exists():
        return []

    deleted: list[Path] = []
    for chunk_file in dest_dir.glob("*.json"):
        file_md_source, _, _, _, _ = _parse_chunk_filename(chunk_file.name)
        matches_source = file_md_source == md_source or (
            md_source == "uploaded" and file_md_source is None
        )
        if not matches_source:
            continue
        try:
            chunk_file.unlink()
            deleted.append(chunk_file)
        except OSError as exc:
            logger.warning("Failed to delete chunks file '%s': %s", chunk_file, exc)
            continue

    try:
        if not any(dest_dir.iterdir()):
            dest_dir.rmdir()
            deleted.append(dest_dir)
    except OSError as exc:
        logger.debug("Failed to remove empty chunks directory '%s': %s", dest_dir, exc)

    return deleted


class ChunkStorageService:
    """Saves enriched chunk sets to deterministic, configuration-keyed files."""

    def __init__(self) -> None:
        settings = get_settings()
        self._chunks_dir = Path(settings.CHUNKS_DIR)
        self._mds_dir = Path(settings.MDS_DIR)

    def save_chunks(self, request: SaveChunksRequest) -> SaveChunksResponse:
        """Persist *request.chunks* to a configuration-keyed JSON file.

        Re-saving with the same MD source + library / algorithm / size /
        overlap overwrites the previous file deterministically.
        """
        stem = _safe_stem(request.filename)
        doc_name = sanitise_token(stem) or "doc"

        md_source = md_source_token(request.md_filename, stem)
        source_md_filename = request.md_filename or _md_filename_for_source(stem, md_source)
        if source_md_filename is not None:
            try:
                document_stem_for_markdown(request.filename, source_md_filename)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        current_source_hash = None
        if source_md_filename:
            source_path = safe_child_path(
                self._mds_dir,
                source_md_filename,
                description="Markdown filename",
            )
            if source_path.is_file():
                current_source_hash = _sha256_markdown(source_path)
        if request.source_hash is None:
            raise HTTPException(
                status_code=409,
                detail="Chunks have no source revision; re-chunk before saving.",
            )
        if current_source_hash is None:
            raise HTTPException(
                status_code=409,
                detail="Source Markdown is missing; chunks cannot be saved.",
            )
        if request.source_hash != current_source_hash:
            raise HTTPException(
                status_code=409,
                detail="Source Markdown changed after these chunks were created; re-chunk before saving.",
            )

        dest_dir = self._chunks_dir / stem
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / _build_chunk_filename(
            doc_name=doc_name,
            md_source=md_source,
            library=request.chunker_library,
            chunker_type=request.chunker_type,
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
            enable_markdown_sizing=request.enable_markdown_sizing,
        )
        normalised_chunks = [_normalise_chunk(c) for c in request.chunks]
        payload: dict[str, Any] = {
            "filename": request.filename,
            "md_source": md_source,
            "source_hash": request.source_hash,
            "chunker_type": request.chunker_type,
            "chunker_library": request.chunker_library,
            "chunk_size": request.chunk_size,
            "chunk_overlap": request.chunk_overlap,
            "enable_markdown_sizing": request.enable_markdown_sizing,
            "saved_at": datetime.now(tz=timezone.utc).isoformat(),
            "total_chunks": len(normalised_chunks),
            "chunks": normalised_chunks,
        }
        atomic_write_text(
            dest_path,
            json.dumps(payload, ensure_ascii=False, indent=2),
        )

        return SaveChunksResponse(
            success=True,
            message=f"Saved {len(normalised_chunks)} chunks for '{request.filename}'",
            path=str(dest_path),
        )

    def load_chunks_by_filename(self, filename: str, chunks_filename: str) -> LoadChunksResponse:
        """Load a specific saved-chunks JSON file by its filename."""
        stem = _safe_stem(filename)
        dest_path = safe_child_path(
            self._chunks_dir / stem, chunks_filename, description="chunks filename",
        )
        if not dest_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Chunks file '{chunks_filename}' not found for '{filename}'",
            )
        return self._read_chunk_file(dest_path)

    def list_versions(self, filename: str) -> list[ChunksVersion]:
        """Return every saved-chunks JSON file for *filename*, newest first."""
        stem = _safe_stem(filename)
        dest_dir = self._chunks_dir / stem
        try:
            json_files = list(dest_dir.glob("*.json"))
        except (FileNotFoundError, OSError):
            return []
        json_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)

        versions: list[ChunksVersion] = []
        for f in json_files:
            md_source, library, algorithm, size, overlap = _parse_chunk_filename(f.name)
            md_filename = _md_filename_for_source(stem, md_source)
            source_hash = None
            try:
                payload = json.loads(f.read_text(encoding="utf-8"))
                raw_hash = payload.get("source_hash")
                if isinstance(raw_hash, str) and raw_hash:
                    source_hash = raw_hash
            except (OSError, json.JSONDecodeError):
                pass
            current_hash = (
                _sha256_markdown(self._mds_dir / md_filename)
                if md_filename is not None else None
            )
            versions.append(ChunksVersion(
                filename=f.name,
                md_filename=md_filename,
                md_source=md_source,
                library=library,
                algorithm=algorithm,
                chunk_size=size,
                chunk_overlap=overlap,
                source_hash=source_hash,
                is_stale=(
                    source_hash is None
                    or current_hash is None
                    or source_hash != current_hash
                ),
            ))
        return versions

    def _read_chunk_file(self, path: Path) -> LoadChunksResponse:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            normalised = [_normalise_chunk(c) for c in payload["chunks"]]
            return LoadChunksResponse(
                chunks=normalised,
                total_chunks=payload["total_chunks"],
                filename=payload["filename"],
                source_hash=(
                    payload.get("source_hash")
                    if isinstance(payload.get("source_hash"), str)
                    else None
                ),
            )
        except (json.JSONDecodeError, OSError) as exc:
            raise HTTPException(status_code=500, detail=f"Saved chunk file is corrupt: {exc}")
        except KeyError as exc:
            raise HTTPException(status_code=500, detail=f"Saved chunk file is missing field: {exc}")
