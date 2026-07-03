"""
Per-piece checkpoint store for the markdown enrichment pipeline.

A 400-page enrichment run can make 100+ LLM calls.  Losing all of that work
to a network blip or a process restart is exactly the pain point the VLM
checkpoint pattern was built to solve, and the same shape works here:
persist each piece's corrected output as it succeeds; on the next run,
skip any piece whose input is unchanged.

Differences from :mod:`backend.converters.vlm_checkpoint`:

    * The on-disk record stores BOTH the corrected content AND a content
      hash, so the cache is invalidated automatically when *any* input
      that determines the LLM output changes (piece content, context,
      prompt, model, base URL, temperature, or document summary).  No
      external manifest to keep in sync.
    * Stored as JSON ``{"hash": "...", "content": "..."}``, not bare
      markdown — the hash keeps every cache hit byte-for-byte correct.

The checkpoint directory lives at ``mds/.checkpoints/{stem}_enrich/`` so
it sits alongside (but cannot collide with) the VLM checkpoint dir for
the same document.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from pathlib import Path

from backend.utils.files import atomic_write_text

logger = logging.getLogger(__name__)

CHECKPOINT_ROOT_NAME = ".checkpoints"
_CONVERTER_TOKEN = "enrich"


def hash_key(
    piece_content: str,
    prompt: str,
    model: str,
    temperature: float,
    document_summary_hash: str = "",
    base_url: str = "",
    previous_context: str = "",
) -> str:
    """Compute the cache key for one piece-correction call.

    The hash covers every input that determines the LLM's output for a
    single piece. The base URL is included because two OpenAI-compatible
    servers may expose the same model name while producing different results.
    The rolling previous context is included because it is part of the actual
    user message sent for this piece. Temperature is included because it
    directly affects sampling and therefore the corrected output.

    ``document_summary_hash`` is the SHA-256 of the canonical encoding
    of the :class:`DocumentSummary` passed alongside the piece (see
    :mod:`document_summary`).  Including it here means that when the
    document-level summary changes — because the user regenerated it,
    or because cleanup/splitting yielded different piece content — every
    downstream piece-correction entry invalidates automatically.  Pass
    the empty string for callers that do not use a document summary;
    that path is hash-distinct from the "has summary, with X content"
    path on purpose.
    """
    h = hashlib.sha256()
    h.update(piece_content.encode("utf-8"))
    h.update(b"\x1e")  # ASCII record separator — keeps fields unambiguous
    h.update(prompt.encode("utf-8"))
    h.update(b"\x1e")
    h.update(model.encode("utf-8"))
    h.update(b"\x1e")
    # Format with fixed precision so trivial float-printing differences
    # (e.g. 0.30000000000000004) don't spuriously invalidate the cache.
    h.update(f"{temperature:.6f}".encode("utf-8"))
    h.update(b"\x1e")
    h.update(document_summary_hash.encode("utf-8"))
    h.update(b"\x1e")
    h.update(base_url.encode("utf-8"))
    h.update(b"\x1e")
    h.update(previous_context.encode("utf-8"))
    return h.hexdigest()


class EnrichmentCheckpointStore:
    """Filesystem-backed per-piece cache for one ``(document, enrichment)`` pair.

    Single-writer assumption: callers should avoid launching two enrichment
    pipelines for the same Markdown variant at the same time.  Atomic writes
    keep individual cache files from being corrupted, but no per-document lock
    is implemented here.
    """

    def __init__(self, stem: str, mds_dir: Path) -> None:
        self._dir = mds_dir / CHECKPOINT_ROOT_NAME / f"{stem}_{_CONVERTER_TOKEN}"

    @property
    def dir(self) -> Path:
        return self._dir

    def exists(self) -> bool:
        return self._dir.exists() and any(self._dir.iterdir())

    @staticmethod
    def _piece_filename(piece_index: int) -> str:
        return f"piece_{piece_index + 1:04d}.json"

    def get(self, piece_index: int, key: str) -> str | None:
        """Return cached corrected content if hash matches *key*, else None.

        A mismatch (or any I/O / JSON error) is treated as a clean miss:
        the caller falls back to a fresh LLM call, and the failed entry
        is silently overwritten by the next successful save.  This makes
        the cache resilient to partial writes, version drift, and
        manually-edited checkpoint files.
        """
        path = self._dir / self._piece_filename(piece_index)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Discarding unreadable enrichment cache entry %s: %s", path, exc)
            return None
        if data.get("hash") != key:
            return None
        content = data.get("content")
        return content if isinstance(content, str) else None

    def set(self, piece_index: int, key: str, content: str) -> None:
        """Atomically persist ``content`` keyed by ``key``.

        Writes to a sibling ``.tmp`` and ``os.replace``s it into place so
        a crash mid-write either leaves the previous record intact or no
        file at all — never a truncated/corrupt JSON document.
        """
        target = self._dir / self._piece_filename(piece_index)
        atomic_write_text(
            target,
            json.dumps({"hash": key, "content": content}, ensure_ascii=False),
        )

    def discard(self) -> None:
        """Delete every cached piece for this document.

        Safe to call when the directory does not exist (no-op).  I/O
        errors are logged but never raised: a stuck cleanup is a
        cosmetic issue, not a data issue — the enrichment that triggered
        the cleanup has already produced its result by the time this is
        called.
        """
        try:
            shutil.rmtree(self._dir, ignore_errors=False)
        except FileNotFoundError:
            return
        except OSError as exc:
            logger.warning(
                "Failed to remove enrichment checkpoint directory '%s': %s",
                self._dir, exc,
            )


def discard_all_for_stem(stem: str, mds_dir: Path) -> None:
    """Remove every enrichment checkpoint directory belonging to ``stem``.

    Called from document delete / re-upload flows with the *document*
    stem (e.g. ``"report"``).  The actual per-piece checkpoint dirs are
    keyed by the *markdown variant* stem
    (``report_vlm_enrich``, ``report_cloud_enrich``, …), so a literal
    ``{stem}_enrich`` lookup misses every converted variant and leaves
    orphan directories behind on disk.

    Glob ``{stem}_*_enrich`` (covers ``report_vlm_enrich``,
    ``report_cloud_enrich``, …) AND ``{stem}_enrich`` (covers
    bare-MD uploads where the markdown stem equals the doc stem).
    Mirrors the VLM checkpoint cleanup's wildcard approach.
    """
    root = mds_dir / CHECKPOINT_ROOT_NAME
    if not root.exists():
        return
    candidates: list[Path] = []
    # Per-variant: ``{stem}_{converter}_enrich``.
    candidates.extend(root.glob(f"{stem}_*_{_CONVERTER_TOKEN}"))
    # Bare-MD upload: ``{stem}_enrich`` (md stem == doc stem).
    bare = root / f"{stem}_{_CONVERTER_TOKEN}"
    if bare.exists() and bare not in candidates:
        candidates.append(bare)
    for candidate in candidates:
        if not candidate.is_dir():
            continue
        try:
            shutil.rmtree(candidate)
        except OSError as exc:
            logger.warning(
                "Failed to remove enrichment checkpoint directory '%s': %s",
                candidate, exc,
            )
