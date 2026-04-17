"""
Abstract base class for PDF-to-Markdown converters.
"""

from abc import ABC, abstractmethod
from pathlib import Path


class PDFConverter(ABC):
    """Base class for all PDF-to-Markdown converters.

    Subclasses must implement :meth:`convert`. They may also override
    :meth:`validate_path` if they need custom pre-flight checks.
    """

    @abstractmethod
    def convert(self, pdf_path: Path, total_pages: int | None = None) -> str:
        """Convert a PDF file to Markdown.

        Args:
            pdf_path:    Absolute or relative path to the PDF file.
            total_pages: Pre-computed page count. When provided, converters
                         that would otherwise open the file solely to read
                         page count (e.g. VLMConverter) can skip that open.
                         Non-VLM converters may ignore this parameter.

        Returns:
            The full document as a Markdown string.

        Raises:
            FileNotFoundError: If *pdf_path* does not exist.
        """

    def validate_path(self, pdf_path: Path) -> None:
        """Raise FileNotFoundError if the file does not exist.

        Called at the start of :meth:`convert` by each subclass.
        Override to add additional checks (e.g. size limits, MIME type).
        """
        if not pdf_path.exists():
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")