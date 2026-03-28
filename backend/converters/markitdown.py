"""
PDF-to-Markdown converter backed by Microsoft MarkItDown.
"""

from pathlib import Path
from backend.registry import register_converter
from .base import PDFConverter

@register_converter(
    name="markitdown",
    label="MarkItDown",
    description="Microsoft MarkItDown. Simple and reliable for standard PDFs.",
)
class MarkItDownConverter(PDFConverter):
    """Broad-format converter using Microsoft's MarkItDown library.

    Simple and reliable for standard PDFs. Plugins are disabled to keep
    the conversion deterministic and dependency-free.

    Install:
        pip install 'markitdown[all]'

    Note:
        MarkItDown is imported lazily so that it does not slow down startup
        when a different converter is selected.
    """

    def __init__(self) -> None:
        from markitdown import MarkItDown

        self._converter = MarkItDown(enable_plugins=False)

    def convert(self, pdf_path: Path, total_pages=None) -> str:
        self.validate_path(pdf_path)
        result = self._converter.convert(str(pdf_path))
        return result.text_content