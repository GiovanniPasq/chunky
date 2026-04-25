"""
Router for the capabilities endpoint.

Prefix: /api

GET /api/capabilities
    Returns all registered chunker libraries + strategies and converters.
    The frontend calls this once on startup to build its UI dynamically.
    No frontend changes are needed when new strategies or converters are added
    to the backend — as long as they are decorated with @register_chunker
    or @register_converter, they will appear here automatically.

Import order matters: the chunker and converter modules must be imported
before this router is mounted so that their decorators have already run and
populated the registry. The safest place to ensure this is in main.py,
where all routers are imported together after the chunker/converter modules.
"""

from fastapi import APIRouter
from backend.registry import registry

# Ensure all chunker and converter modules are imported so their decorators
# have run before the first request hits /api/capabilities.
import backend.chunkers.langchain_chunker   # noqa: F401 — side-effect import
import backend.chunkers.chonkie_chunker     # noqa: F401 — side-effect import
import backend.chunkers.docling_chunker     # noqa: F401 — side-effect import
import backend.converters.pymupdf             # noqa: F401 — side-effect import
import backend.converters.markitdown          # noqa: F401 — side-effect import
import backend.converters.docling             # noqa: F401 — side-effect import
import backend.converters.vlm                 # noqa: F401 — side-effect import
import backend.converters.cloud               # noqa: F401 — side-effect import
import backend.converters.liteparse           # noqa: F401 — side-effect import

router = APIRouter(prefix="/api", tags=["capabilities"])


@router.get("/capabilities")
async def get_capabilities():
    """Return all available chunking strategies and PDF converters.

    The response shape is stable; new entries appear automatically
    as new chunkers/converters are registered.

    Response example::

        {
          "chunkers": [
            {
              "library": "langchain",
              "label": "LangChain",
              "strategies": [
                {"strategy": "token",     "label": "Token",     "description": "..."},
                {"strategy": "recursive", "label": "Recursive", "description": "..."},
                {"strategy": "character", "label": "Character", "description": "..."},
                {"strategy": "markdown",  "label": "Markdown",  "description": "..."}
              ]
            },
            {
              "library": "chonkie",
              "label": "Chonkie",
              "strategies": [ ... ]
            }
          ],
          "converters": [
            {"name": "pymupdf",    "label": "PyMuPDF",    "description": "..."},
            {"name": "markitdown", "label": "MarkItDown", "description": "..."},
            {"name": "docling",    "label": "Docling",    "description": "..."},
            {"name": "vlm",        "label": "VLM (Vision-Language Model)", "description": "..."}
          ]
        }
    """
    return registry.get_capabilities()