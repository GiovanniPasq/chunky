"""
PDF-to-Markdown converter backed by Docling.
"""

from pathlib import Path
from backend.registry import register_converter
from .base import PDFConverter

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

    def convert(self, pdf_path: Path) -> str:
        from docling_core.types.doc import ImageRefMode

        self.validate_path(pdf_path)

        result = self._converter.convert(str(pdf_path))
        return result.document.export_to_markdown(
            image_mode=ImageRefMode.PLACEHOLDER,
            image_placeholder="",
        )