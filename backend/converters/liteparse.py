"""
PDF-to-Markdown converter backed by LiteParse (llama-index).

Requires:
    pip install liteparse
"""

from pathlib import Path

from backend.registry import register_converter

from .base import PDFConverter
from .pages import page_markdown


@register_converter(
    name="liteparse",
    page_mapping=True,
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

        # Native header/footer removal can classify all text on short pages as
        # running furniture. Preserve it; cleanup is an explicit later step.
        parser = LiteParse(output_format="markdown", keep_headers_footers=True)
        result = parser.parse(str(pdf_path))
        return page_markdown(
            ((page.page_num, page.markdown) for page in result.pages),
            total_pages or result.total_pages,
        )
