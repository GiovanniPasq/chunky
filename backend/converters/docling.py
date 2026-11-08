"""
PDF-to-Markdown converter backed by Docling.
"""

from pathlib import Path
from backend.registry import register_converter
from .base import PDFConverter
from .pages import page_markdown

@register_converter(
    name="docling",
    label="Docling",
    description="Layout-aware. Handles multi-column, tables, and complex structures.",
)
class DoclingConverter(PDFConverter):
    """Advanced layout-aware converter using the Docling library.

    Handles complex document structures (multi-column, tables, figures).
    Images are excluded from the Markdown output.

    Install:
        pip install docling

    Note:
        Docling is imported lazily to avoid a heavy startup cost when the
        converter is not selected.
    """

    def __init__(self) -> None:
        # Lazy import: Docling has a significant import time and pulls in
        # heavy ML dependencies. We defer it until the converter is actually used.
        from docling.document_converter import DocumentConverter

        self._converter = DocumentConverter()

    def convert(self, pdf_path: Path, total_pages=None) -> str:
        from docling_core.types.doc import ImageRefMode

        self.validate_path(pdf_path)

        result = self._converter.convert(str(pdf_path))
        document = result.document
        # Docling assigns compound items (e.g. merged tables) to their first
        # provenance page. Serialize them once, without duplicating their rows.
        if not document.pages:
            return document.export_to_markdown(image_mode=ImageRefMode.PLACEHOLDER, image_placeholder="")
        count = total_pages or max(document.pages)
        return page_markdown((
            (number, document.export_to_markdown(
                page_no=number, image_mode=ImageRefMode.PLACEHOLDER, image_placeholder="",
            )) for number in range(1, count + 1)
        ), count)
