"""Helpers for associating PDFs with Markdown variants on disk."""

from __future__ import annotations

import re
from pathlib import Path

from backend.utils.naming import KNOWN_CONVERTERS
from backend.utils.path import safe_child_path, safe_filename

_FAILURE_MARKER_RE = re.compile(r"<!--\s*page\s+\d+\s+failed:")


def file_has_failure_markers(path: Path) -> bool:
    """Return True iff *path* contains at least one VLM failure placeholder."""
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if _FAILURE_MARKER_RE.search(line):
                    return True
        return False
    except OSError:
        return False


def markdown_belongs_to_stem(md_file: Path, stem: str) -> bool:
    """Return True only for the exact upload or a known converted variant."""
    if md_file.suffix.lower() != ".md":
        return False
    if md_file.stem == stem:
        return True
    prefix = f"{stem}_"
    if not md_file.stem.startswith(prefix):
        return False
    token = md_file.stem[len(prefix):]
    return token in KNOWN_CONVERTERS


def document_stem_for_markdown(
    document_name: str | None,
    md_filename: str,
) -> str:
    """Return the authoritative owner stem for a Markdown file.

    New callers pass the selected document name explicitly.  This removes the
    ambiguity of standalone uploads whose natural filename happens to end in a
    converter token (for example ``notes_vlm.md``).  Suffix parsing remains a
    compatibility fallback for older clients that do not send an owner.
    """
    md_name = safe_filename(md_filename, "Markdown filename")
    if document_name is None:
        from backend.utils.naming import doc_stem_from_md
        return doc_stem_from_md(md_name)

    owner_name = safe_filename(document_name, "document name")
    owner_stem = Path(owner_name).stem
    if owner_name.lower().endswith(".md"):
        if owner_name != md_name:
            raise ValueError(
                f"Markdown '{md_name}' does not belong to standalone document '{owner_name}'"
            )
        return owner_stem

    if not markdown_belongs_to_stem(Path(md_name), owner_stem):
        raise ValueError(
            f"Markdown '{md_name}' does not belong to document '{owner_name}'"
        )
    return owner_stem


def md_files_for_stem(mds_dir: Path, stem: str) -> list[Path]:
    """Return every Markdown file on disk that belongs to *stem*."""
    if not mds_dir.exists():
        return []
    return [
        f for f in mds_dir.glob(f"{stem}*.md")
        if markdown_belongs_to_stem(f, stem)
    ]


def preferred_markdown_for_stem(mds_dir: Path, stem: str) -> Path | None:
    """Return the default Markdown variant for a document stem.

    Converted variants are preferred over the uploaded ``{stem}.md``
    file so a PDF that has been converted opens the converter output by
    default.  Sorting keeps the choice stable across filesystems.
    """
    candidates = md_files_for_stem(mds_dir, stem)
    if not candidates:
        return None
    converted = sorted(p for p in candidates if p.stem != stem)
    if converted:
        return converted[0]
    return sorted(candidates)[0]


def find_markdown_for_document(
    filename: str,
    mds_dir: Path,
    md_filename: str | None = None,
) -> Path | None:
    """Locate the Markdown file the chunking worker should read."""
    stem = Path(filename).stem

    if md_filename:
        candidate = safe_child_path(mds_dir, md_filename, description="Markdown filename")
        if candidate.exists() and markdown_belongs_to_stem(candidate, stem):
            return candidate

    direct = mds_dir / filename if filename.lower().endswith(".md") else None
    if direct is not None and direct.exists() and markdown_belongs_to_stem(direct, stem):
        return direct

    return preferred_markdown_for_stem(mds_dir, stem)
