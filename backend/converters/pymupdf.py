"""
PDF-to-Markdown converter backed by pymupdf4llm.
"""

from pathlib import Path

import pymupdf4llm
from backend.registry import register_converter
from .base import PDFConverter
from .pages import page_markdown

@register_converter(
    name="pymupdf",
    label="PyMuPDF",
    description="Fast, lightweight. Best for standard digital PDFs with selectable text.",
)
class PyMuPDFConverter(PDFConverter):
    """Fast, lightweight converter using pymupdf4llm.

    Best suited for standard digital PDFs with selectable text.
    Produces clean Markdown with good table support.

    Install:
        pip install pymupdf4llm
    """

    def convert(self, pdf_path: Path, total_pages=None) -> str:
        self.validate_path(pdf_path)
        pages = pymupdf4llm.to_markdown(str(pdf_path), page_chunks=True)
        return page_markdown(
            ((item['metadata']['page_number'], item['text']) for item in pages), total_pages,
        )