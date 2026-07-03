"""
Shared naming/normalisation logic for converters, chunker algorithms, and the
Markdown-source token embedded in chunk filenames.

Centralised here so that every layer that builds or parses one of these
filenames — document_service (writes ``{stem}_{converter}.md``),
chunk_storage_service (writes/reads ``{doc}_{md_source}_{lib}-{algo}…``), and
the routers that surface them — speaks one vocabulary.  Adding a new
converter or chunker library only requires updating this module.
"""

from __future__ import annotations

import re
from pathlib import Path


# ---------------------------------------------------------------------------
# Converters (PDF → Markdown)
# ---------------------------------------------------------------------------

# Wire-level ConverterType value → normalised lowercase token used inside
# Markdown filenames (``{stem}_{converter}.md``) and as a chunk-file
# md_source segment.
CONVERTER_NORMALIZATION: dict[str, str] = {
    "pymupdf": "pymupdf4llm",
    "docling": "docling",
    "markitdown": "markitdown",
    "liteparse": "liteparse",
    "vlm": "vlm",
    "cloud": "cloud",
}

KNOWN_CONVERTERS: frozenset[str] = frozenset(CONVERTER_NORMALIZATION.values())


def normalise_converter(converter: str | None) -> str:
    """Map a wire-level converter name to its filename token (or ``"unknown"``)."""
    if not converter:
        return "unknown"
    key = converter.lower().strip()
    if key in CONVERTER_NORMALIZATION:
        return CONVERTER_NORMALIZATION[key]
    return re.sub(r"[^a-z0-9]+", "", key) or "unknown"


# ---------------------------------------------------------------------------
# Chunker libraries / algorithms
# ---------------------------------------------------------------------------

KNOWN_LIBRARIES: frozenset[str] = frozenset({"langchain", "chonkie", "docling"})

# Chonkie algorithms that don't accept ``chunk_overlap`` (kept in sync with
# the frontend's CHONKIE_NO_OVERLAP set in SettingsModal.tsx).
_CHONKIE_NO_OVERLAP: frozenset[str] = frozenset({
    "recursive", "fast", "table", "code", "late", "neural", "slumber",
})
_CHONKIE_NO_SIZE: frozenset[str] = frozenset({"table", "neural"})


def algo_to_filename_token(chunker_type: str | None) -> str:
    """Encode a wire-level chunker type for safe inclusion in a filename.

    Underscores (only ``line_based`` today) are rewritten as hyphens so the
    top-level ``_`` separator stays unambiguous.
    """
    return (chunker_type or "unknown").lower().strip().replace("_", "-")


def algo_from_filename_token(token: str) -> str:
    """Inverse of :func:`algo_to_filename_token`."""
    return token.replace("-", "_")


def params_used_by(
    library: str | None,
    chunker_type: str | None,
    enable_markdown_sizing: bool,
) -> tuple[bool, bool]:
    """Return ``(uses_size, uses_overlap)`` for a library/algorithm combo.

    Mirrors the disabled-state logic of the frontend Settings modal so that
    chunk filenames only encode parameters that actually influence the
    underlying splitter.
    """
    lib = (library or "").lower()
    algo = (chunker_type or "").lower()

    if lib == "langchain":
        if algo == "markdown":
            return (enable_markdown_sizing, enable_markdown_sizing)
        return (True, True)
    if lib == "docling":
        return (True, False)
    if lib == "chonkie":
        uses_size = algo not in _CHONKIE_NO_SIZE
        return (uses_size, uses_size and algo not in _CHONKIE_NO_OVERLAP)
    return (True, True)


# ---------------------------------------------------------------------------
# Markdown source token (segment embedded in chunk filenames)
# ---------------------------------------------------------------------------

# Tokens recognised in the ``<md_source>`` segment of a chunk filename.
# ``"uploaded"`` covers any Markdown the user uploaded directly (no
# converter suffix).
KNOWN_MD_SOURCES: frozenset[str] = frozenset(KNOWN_CONVERTERS | {"uploaded"})


def md_source_token(md_filename: str | None, doc_stem: str) -> str:
    """Return the token identifying the source Markdown for a chunk file.

    Recognises the ``{doc_stem}_{converter}.md`` pattern produced by the
    conversion pipeline; falls back to ``"uploaded"`` for any other shape.
    """
    if not md_filename:
        return "uploaded"
    stem = Path(md_filename).stem
    prefix = f"{doc_stem}_"
    if stem.startswith(prefix):
        token = stem[len(prefix):]
        if token in KNOWN_CONVERTERS:
            return token
    return "uploaded"


def doc_stem_from_md(md_filename: str) -> str:
    """Recover the document stem from a markdown variant filename.

    ``report_vlm.md`` → ``report``;  ``multi_word_doc_cloud.md`` →
    ``multi_word_doc``;  ``legacy.md`` → ``legacy``.  Strips one trailing
    ``_{converter}`` segment when ``converter`` is a known converter token;
    otherwise returns the stem unchanged.  Used by the document-summary
    store so a summary file is shared across every converter variant of
    the same source PDF.
    """
    stem = Path(md_filename).stem
    if "_" not in stem:
        return stem
    head, _, tail = stem.rpartition("_")
    if tail in KNOWN_CONVERTERS:
        return head
    return stem


# ---------------------------------------------------------------------------
# Sanitisation
# ---------------------------------------------------------------------------


def sanitise_token(value: str) -> str:
    """Replace non-alphanumeric runs with hyphens; collapse repeats."""
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-zA-Z0-9]", "-", value)).strip("-")
