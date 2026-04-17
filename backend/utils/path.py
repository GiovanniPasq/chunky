"""
Shared path-safety utilities.

Centralises the path-traversal guard used by document_service and
chunk_storage_service so the validation logic has a single source of truth.
"""

from pathlib import Path

from fastapi import HTTPException


def safe_filename(filename: str, description: str = "filename") -> str:
    """Validate and return the bare filename, raising HTTP 400 on invalid input.

    Rejects any value that contains directory separators, is empty, or resolves
    to a traversal component (``..``).  The check ``name != filename`` catches
    inputs like ``"../secret.pdf"`` where ``Path.name`` would silently strip
    the traversal prefix.

    Args:
        filename:    The raw filename string from the request.
        description: Human-readable label used in the error message.

    Returns:
        The validated bare filename (guaranteed to be equal to ``Path(filename).name``).

    Raises:
        HTTPException(400): If the filename is missing, contains traversal
                            components, or is syntactically invalid.
    """
    try:
        name = Path(filename).name
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {description} '{filename}'.",
        )
    if not name or name != filename or name in (".", ".."):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {description} '{filename}': path traversal is not allowed.",
        )
    return name


def safe_stem(filename: str) -> str:
    """Validate a filename and return its stem (no extension).

    Used by chunk_storage_service where directory keys are derived from the
    stem (e.g. ``chunks/report/`` for ``report.pdf``).

    Args:
        filename: The raw filename string from the request.

    Returns:
        The stem of the validated filename.

    Raises:
        HTTPException(400): On invalid or traversal-containing input.
    """
    try:
        name = Path(filename).name
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"Invalid filename '{filename}'.")
    if not name or name in (".", ".."):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid filename '{filename}': path traversal is not allowed.",
        )
    stem = Path(name).stem
    if not stem or stem in (".", ".."):
        raise HTTPException(status_code=400, detail=f"Invalid filename '{filename}'.")
    return stem
