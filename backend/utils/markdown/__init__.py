"""Pure-function markdown utilities used by the enrichment pipeline.

``cleanup`` and ``splitter`` were originally siblings of the stateful
services in ``backend/services/``, but they have no I/O or state — they
are deterministic transformations of a string into a string (or a list
of dataclasses).  Hosting them under ``backend/utils/`` lines them up
with the other pure helpers in this package (``naming``, ``path``,
``sse``, …) and keeps ``services/`` focused on actual services.

Re-exports the public surface so callers can ``from backend.utils.markdown
import clean_markdown, split_markdown`` without having to know which
submodule each lives in.
"""

from .cleanup import CleanupReport, clean_markdown
from .splitter import Piece, has_model_content, rolling_context, split_markdown

__all__ = [
    "CleanupReport",
    "Piece",
    "clean_markdown",
    "has_model_content",
    "rolling_context",
    "split_markdown",
]
