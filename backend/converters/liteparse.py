"""
PDF-to-Markdown converter backed by LiteParse (llama-index).

Requires:
    pip install liteparse
"""

from pathlib import Path

from backend.registry import register_converter

from .base import PDFConverter


@register_converter(
    name="liteparse",
    label="LiteParse",
    description="LlamaIndex LiteParse — fast, model-free PDF-to-Markdown parsing.",
)
class LiteParseConverter(PDFConverter):
    """PDF-to-Markdown converter using the LiteParse engine.

    Install:
        pip install liteparse
    """

    def convert(self, pdf_path: Path, total_pages=None) -> str:
        self.validate_path(pdf_path)
        from liteparse import LiteParse  # local import — optional dependency

        parser = LiteParse(output_format="markdown")
        result = parser.parse(str(pdf_path))
        return result.text
