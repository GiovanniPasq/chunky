"""
Per-page checkpoint store for the VLM converter.

A 400-page VLM job can take hours and burn meaningful API spend.  When a job
is interrupted (network blip, process crash, user disconnect, model failure),
losing every page already transcribed is the dominant pain point of the
current implementation.

This module persists each successfully transcribed page to its own file under
``{MDS_DIR}/.checkpoints/{stem}_vlm/page_NNNN.md``.  On the next run, the VLM
converter consults the store before rendering or calling the model — pages
already on disk are returned verbatim and the API call is skipped entirely.

Design notes:
    * **No manifest / no auto-invalidation.**  The "Resume from checkpoint"
      checkbox in the UI is the sole control.  Stale caches that survive a
      PDF replacement are handled at upload time (the upload service wipes
      the checkpoint directory when overwriting an existing PDF).
    * **Atomic writes via ``os.replace``.**  A crash mid-write cannot leave
      a half-written page file on disk, which would otherwise be loaded as
      truncated Markdown on the next run.
    * **Cheap on disk.**  Each page is a few KB of Markdown; a 400-page job
      consumes ~1-4 MB.  No compression needed.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from backend.utils.files import atomic_write_text

logger = logging.getLogger(__name__)

# Directory name (under MDS_DIR) that holds all per-document checkpoint trees.
CHECKPOINT_ROOT_NAME = ".checkpoints"

# Token appended to the document stem to form the checkpoint subdirectory.
# Kept as a separate constant so future converters that adopt checkpointing
# can plug in their own token without colliding with VLM's.
_CONVERTER_TOKEN = "vlm"


def _page_filename(page_num: int) -> str:
    """Return the on-disk filename for a 0-indexed page number.

    Pages are stored 1-indexed (matching how users think about pages) and
    zero-padded to four digits so directory listings sort naturally.
    """
    return f"page_{page_num + 1:04d}.md"


class CheckpointStore:
    """Filesystem-backed per-page cache for one ``(document, vlm)`` pair.

    Each instance is bound to a specific document stem and is safe to use
    from a single conversion at a time. The local UI exposes one blocking
    conversion workflow, so no per-document filesystem lock is implemented.
    """

    def __init__(self, stem: str, mds_dir: Path) -> None:
        """Create a store handle (does not touch disk).

        Args:
            stem:    Document stem (e.g. ``"report"`` for ``"report.pdf"``).
                     Must already be validated by the caller — this class
                     trusts its inputs and does not perform path-traversal
                     checks of its own.
            mds_dir: Directory under which ``.checkpoints/`` lives.
        """
        self._dir = mds_dir / CHECKPOINT_ROOT_NAME / f"{stem}_{_CONVERTER_TOKEN}"

    @property
    def dir(self) -> Path:
        """Absolute path to this checkpoint directory (may not exist)."""
        return self._dir

    def exists(self) -> bool:
        """True if any cached pages are on disk for this document."""
        return self._dir.exists() and any(self._dir.iterdir())

    def has_page(self, page_num: int) -> bool:
        """True if page ``page_num`` (0-indexed) is already on disk."""
        return (self._dir / _page_filename(page_num)).is_file()

    def load_page(self, page_num: int) -> str:
        """Return the cached Markdown for ``page_num`` (0-indexed).

        Raises:
            FileNotFoundError: If no checkpoint exists for that page.
        """
        return (self._dir / _page_filename(page_num)).read_text(encoding="utf-8")

    def save_page(self, page_num: int, markdown: str) -> None:
        """Atomically persist ``markdown`` for ``page_num`` (0-indexed).

        Writes to a sibling ``.tmp`` file first and then ``os.replace``s it
        into place, so a crash mid-write leaves either the previous version
        on disk (if any) or no file at all — never a truncated one.
        """
        target = self._dir / _page_filename(page_num)
        atomic_write_text(target, markdown)

    def completed_pages(self) -> list[int]:
        """Return the sorted 0-indexed list of pages already cached on disk.

        Used by the converter to emit an initial "resumed from page N"
        signal so the UI can pre-fill the progress bar.
        """
        if not self._dir.exists():
            return []
        pages: list[int] = []
        for f in self._dir.glob("page_*.md"):
            try:
                # filename layout: ``page_NNNN.md`` → strip prefix + suffix
                pages.append(int(f.stem[len("page_"):]) - 1)
            except ValueError:
                # Unknown file shape — ignore rather than crash the whole job.
                logger.warning("Ignoring unrecognised checkpoint file: %s", f)
        pages.sort()
        return pages

    def discard(self) -> None:
        """Delete the checkpoint directory and every cached page.

        Safe to call when the directory does not exist (no-op).  Errors are
        logged but never raised: a failed cleanup is a cosmetic issue, not
        a data issue — the conversion that triggered the cleanup has
        already succeeded by the time this is called.
        """
        try:
            shutil.rmtree(self._dir, ignore_errors=False)
        except FileNotFoundError:
            return
        except OSError as exc:
            logger.warning(
                "Failed to remove checkpoint directory '%s': %s",
                self._dir, exc,
            )


def discard_all_for_stem(stem: str, mds_dir: Path) -> None:
    """Remove every checkpoint directory belonging to ``stem``.

    Used at upload-overwrite and delete time, when the source PDF is going
    away (or being replaced) and any cached pages would be either
    unreferenced or actively misleading.  Wildcard matches future converter
    tokens too (``{stem}_vlm``, ``{stem}_<future>``), so this stays correct
    if checkpointing is later extended to other converters.
    """
    root = mds_dir / CHECKPOINT_ROOT_NAME
    if not root.exists():
        return
    for candidate in root.glob(f"{stem}_*"):
        if not candidate.is_dir():
            continue
        try:
            shutil.rmtree(candidate)
        except OSError as exc:
            logger.warning(
                "Failed to remove checkpoint directory '%s': %s",
                candidate, exc,
            )
