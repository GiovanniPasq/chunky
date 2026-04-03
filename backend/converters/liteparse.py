"""
PDF-to-Markdown converter backed by LiteParse (llama-index).

Requires:
    npm install -g @llamaindex/liteparse
    pip install liteparse

LiteParse invokes the Node.js CLI through subprocess calls, so the GIL is
released during conversion and this converter is safe to run inside a thread
(asyncio.to_thread) without blocking the event loop.
"""

from pathlib import Path

from backend.registry import register_converter

from .base import PDFConverter


@register_converter(
    name="liteparse",
    label="LiteParse",
    description="LlamaIndex LiteParse — high-performance parsing via Node.js engine.",
)
class LiteParseConverter(PDFConverter):
    """PDF-to-Markdown converter using the LiteParse Node.js engine.

    LiteParse runs an external Node.js process and returns the parsed
    document as a Markdown string via ``result.text``.  Because it is
    subprocess-based the Python thread just waits on I/O, so it is safe to
    run inside ``asyncio.to_thread``.

    Install:
        npm install -g @llamaindex/liteparse
        pip install liteparse
    """

    def convert(self, pdf_path: Path, total_pages=None) -> str:
        self.validate_path(pdf_path)
        from liteparse import LiteParse  # local import — optional dependency

        parser = LiteParse()
        result = parser.parse(str(pdf_path))
        return result.text
