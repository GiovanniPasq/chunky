"""
PDF-to-Markdown converter using any OpenAI-compatible Vision-Language Model.

Defaults to Ollama running locally (llama3.2-vision), but can be pointed at
any provider that exposes an OpenAI-compatible chat completions endpoint.
"""

from __future__ import annotations

import os
import re
import base64
from pathlib import Path
from typing import Callable, Optional
from backend.registry import register_converter
from .base import PDFConverter

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are an expert document parser specializing in converting PDF pages to markdown format.

**Your task:** Extract ALL content from the provided page image and return it as clean, well-structured markdown.

**Text Extraction Rules:**
1. Preserve the EXACT text as written (including typos, formatting, special characters)
2. Maintain the logical reading order (top-to-bottom, left-to-right)
3. Preserve hierarchical structure using appropriate markdown headers (#, ##, ###)
4. Keep paragraph breaks and line spacing as they appear
5. Use markdown lists (-, *, 1.) for bullet points and numbered lists
6. Preserve text emphasis: **bold**, *italic*, `code`
7. For multi-column layouts, extract left column first, then right column

**Tables:**
- Convert all tables to markdown table format
- Preserve column alignment and structure
- Use | for columns and - for headers

**Mathematical Formulas:**
- Convert to LaTeX format: inline `$...$`, display `$$...$$`
- If LaTeX conversion is uncertain, describe the formula clearly

**Images, Diagrams, Charts:**
- Insert markdown image placeholder: `![Description](image)`
- Provide a detailed, informative description including:
  * Type of visual (photo, diagram, chart, graph, illustration)
  * Main subject or purpose
  * Key elements, labels, or data points
  * Colors, patterns, or notable visual features
  * Context or relationship to surrounding text
- For charts/graphs: mention axes, data trends, and key values
- For diagrams: describe components and their relationships

**Special Elements:**
- Footnotes: Use markdown footnote syntax `[^1]`
- Citations: Preserve as written
- Code blocks: Use triple backticks with language specification
- Quotes: Use `>` for blockquotes
- Links: Preserve as `[text](url)` if visible

**Quality Guidelines:**
- DO NOT add explanations, comments, or meta-information
- DO NOT skip or summarize content
- DO NOT invent or hallucinate text not present in the image
- DO NOT include "Here is the markdown..." or similar preambles
- Output ONLY the markdown content, nothing else

**Output Format:**
Return raw markdown with no wrapper, no code blocks, no explanations. Start immediately with the page content."""

# DPI used when rasterising each PDF page before sending it to the VLM.
# 300 DPI gives a good balance between quality and token / bandwidth cost.
_RENDER_DPI = 300
_DPI_SCALE = _RENDER_DPI / 72  # fitz uses 72 DPI as its baseline

# Default base URL: reads from env var if set, otherwise falls back to localhost
# (localhost works when running outside Docker; inside Docker the compose file
# sets OLLAMA_BASE_URL=http://host.docker.internal:11434/v1)
_DEFAULT_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")


@register_converter(
    name="vlm",
    label="VLM (Vision-Language Model)",
    description=(
        "Rasterises each page and sends it to an OpenAI-compatible VLM. "
        "Best quality for scanned PDFs. Requires a running model endpoint."
    ),
)
class VLMConverter(PDFConverter):
    """PDF-to-Markdown converter using any OpenAI-compatible VLM.

    Each page is rasterised at :data:`_RENDER_DPI` DPI and sent to the model
    as a base64-encoded PNG embedded in a ``data:`` URI.

    The default configuration targets a locally running Ollama server, which
    requires **no API key** and **no internet access**.

    Provider examples::

        # Ollama (default) — no API key required
        converter = VLMConverter()

        # Different local model
        converter = VLMConverter(model="minicpm-v")

        # OpenAI
        converter = VLMConverter(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            api_key="sk-...",
        )

        # Google Gemini via its OpenAI-compatible endpoint
        converter = VLMConverter(
            model="gemini-2.5-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key="AIza...",
        )

    Install:
        pip install openai pymupdf
        ollama pull qwen3-vl:4b-instruct-q4_K_M  # for the default local setup
    """

    def __init__(
        self,
        model: str = "qwen3-vl:4b-instruct-q4_K_M",
        base_url: str = _DEFAULT_BASE_URL,
        api_key: str = "ollama",
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> None:
        """Initialise the converter and create the OpenAI client.

        Args:
            model:       Model identifier passed to the completions endpoint.
            base_url:    Root URL of the OpenAI-compatible API.
            api_key:     Authentication key. Any non-empty string works for Ollama.
            on_progress: Optional callback called after each page with
                         ``(current_page, total_pages)`` (1-based).
        """
        from openai import OpenAI

        self._model = model
        self._client = OpenAI(base_url=base_url, api_key=api_key)
        self._on_progress = on_progress

    # ------------------------------------------------------------------
    # PDFConverter interface
    # ------------------------------------------------------------------

    def convert(self, pdf_path: Path) -> str:
        """Render every page and send each one to the VLM for transcription.

        Args:
            pdf_path: Path to the PDF file.

        Returns:
            Full document as Markdown, pages separated by ``\\n\\n---\\n\\n``.
        """
        import fitz  # PyMuPDF

        self.validate_path(pdf_path)

        pages: list[str] = []

        with fitz.open(str(pdf_path)) as pdf_document:
            total = pdf_document.page_count
            for page_num in range(total):
                page = pdf_document[page_num]
                img_b64 = self._render_page_as_b64(page)
                markdown = self._transcribe_page(img_b64)
                pages.append(markdown)
                if self._on_progress:
                    self._on_progress(page_num + 1, total)

        return "\n\n---\n\n".join(pages)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _render_page_as_b64(page) -> str:
        """Rasterise a fitz page and return a base64-encoded PNG string."""
        matrix = __import__("fitz").Matrix(_DPI_SCALE, _DPI_SCALE)
        pix = page.get_pixmap(matrix=matrix)
        return base64.b64encode(pix.tobytes("png")).decode("utf-8")

    def _transcribe_page(self, img_b64: str) -> str:
        """Send a base64 page image to the VLM and return the Markdown text."""
        response = self._client.chat.completions.create(
            model=self._model,
            temperature=0.1,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{img_b64}"},
                        },
                        {
                            "type": "text",
                            "text": "Convert this PDF page to markdown following the instructions.",
                        },
                    ],
                },
            ],
        )
        content = response.choices[0].message.content or ""
        content = content.strip()
        content = re.sub(r"^```(?:markdown)?\n?", "", content)
        content = re.sub(r"\n?```$", "", content)
        return content.strip()