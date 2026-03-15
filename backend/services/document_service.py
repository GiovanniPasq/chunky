"""
Document service — orchestrates PDF upload, conversion, and deletion.
"""

from __future__ import annotations

import shutil
import threading
from pathlib import Path
from typing import Callable, List, Optional, Type

from fastapi import HTTPException, UploadFile

from backend.converters.base import PDFConverter
from backend.converters.docling import DoclingConverter
from backend.converters.markitdown import MarkItDownConverter
from backend.converters.pymupdf import PyMuPDFConverter
from backend.converters.minimax import MinimaxConverter
from backend.converters.vlm import VLMConverter
from backend.models.schemas import (
    ConversionProgressResponse,
    ConvertResponse,
    ConverterType,
    DeleteResponse,
    DocumentInfo,
    MdToPdfResponse,
    MultiUploadResponse,
    UploadFileResult,
    VLMSettings,
)

# ---------------------------------------------------------------------------
# Storage paths
# ---------------------------------------------------------------------------

PDFS_DIR = Path("docs/pdfs")
MDS_DIR = Path("docs/mds")
CHUNKS_DIR = Path("chunks")


# ---------------------------------------------------------------------------
# Conversion progress store
# ---------------------------------------------------------------------------


class _ProgressStore:
    """Thread-safe store that tracks in-flight conversion progress per filename."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, dict] = {}

    def start(self, filename: str) -> None:
        with self._lock:
            self._data[filename] = {"active": True, "current": 0, "total": 0}

    def update(self, filename: str, current: int, total: int) -> None:
        with self._lock:
            self._data[filename] = {"active": True, "current": current, "total": total}

    def finish(self, filename: str) -> None:
        with self._lock:
            self._data.pop(filename, None)

    def get(self, filename: str) -> ConversionProgressResponse:
        with self._lock:
            d = self._data.get(filename, {})
        return ConversionProgressResponse(
            active=d.get("active", False),
            current=d.get("current", 0),
            total=d.get("total", 0),
        )


# Module-level singleton — imported by the router to serve the progress endpoint.
progress_store = _ProgressStore()

# Converter registry — maps enum value to class (excludes VLM which needs args)
_CONVERTER_MAP: dict[ConverterType, Type[PDFConverter]] = {
    ConverterType.pymupdf: PyMuPDFConverter,
    ConverterType.docling: DoclingConverter,
    ConverterType.markitdown: MarkItDownConverter,
}

_ALLOWED_EXTENSIONS = {".pdf", ".md"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stem(filename: str) -> str:
    return Path(filename).stem


def _dest_dir(filename: str) -> Path:
    """Return the target directory for a given filename, or raise 400."""
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        return PDFS_DIR
    if ext == ".md":
        return MDS_DIR
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported file type '{ext}'. Allowed: .pdf, .md",
    )


def _build_converter(
    converter_type: ConverterType,
    vlm_settings: Optional[VLMSettings],
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> PDFConverter:
    """Instantiate the requested converter, forwarding VLM settings when relevant."""
    if converter_type in (ConverterType.vlm, ConverterType.minimax):
        kwargs: dict = {}
        if vlm_settings:
            if vlm_settings.model:
                kwargs["model"] = vlm_settings.model
            if vlm_settings.base_url:
                kwargs["base_url"] = vlm_settings.base_url
            if vlm_settings.api_key:
                kwargs["api_key"] = vlm_settings.api_key
        if on_progress:
            kwargs["on_progress"] = on_progress
        if converter_type == ConverterType.minimax:
            return MinimaxConverter(**kwargs)
        return VLMConverter(**kwargs)

    return _CONVERTER_MAP[converter_type]()


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class DocumentService:
    """Handles all document-level operations: listing, uploading, converting, deleting."""

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def list_documents(self) -> List[str]:
        """Return a sorted list of all available documents (PDFs + MD-only files)."""
        results: List[str] = []
        pdf_stems: set = set()

        if PDFS_DIR.exists():
            for f in PDFS_DIR.glob("*.pdf"):
                results.append(f.name)
                pdf_stems.add(f.stem)

        # Include MD files that have no matching PDF
        if MDS_DIR.exists():
            for f in MDS_DIR.glob("*.md"):
                if f.stem not in pdf_stems:
                    results.append(f.name)

        return sorted(results)

    def get_document(self, filename: str) -> DocumentInfo:
        """Return metadata and existing Markdown content for a PDF or MD-only file."""
        ext = Path(filename).suffix.lower()

        if ext == ".md":
            md_path = MDS_DIR / filename
            if not md_path.exists():
                raise HTTPException(status_code=404, detail=f"MD '{filename}' not found")
            md_content = md_path.read_text(encoding="utf-8")
            pdf_filename = f"{_stem(filename)}.pdf"
            return DocumentInfo(
                pdf_filename=pdf_filename,
                md_filename=filename,
                md_content=md_content,
                has_markdown=True,
                has_pdf=False,
            )

        # Default: PDF file
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        md_filename = f"{_stem(filename)}.md"
        md_path = MDS_DIR / md_filename
        md_content = md_path.read_text(encoding="utf-8") if md_path.exists() else ""

        return DocumentInfo(
            pdf_filename=filename,
            md_filename=md_filename,
            md_content=md_content,
            has_markdown=md_path.exists(),
            has_pdf=True,
        )

    def get_pdf_path(self, filename: str) -> Path:
        """Resolve a PDF filename to its absolute path, raising 404 if missing."""
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")
        return pdf_path

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def upload_file(self, file: UploadFile) -> UploadResponse:
        """Persist a single uploaded PDF or Markdown file.

        Storage layout:
        - .pdf → docs/pdfs/
        - .md  → docs/mds/
        """
        name = file.filename or ""
        dest_dir = _dest_dir(name)
        dest_dir.mkdir(parents=True, exist_ok=True)

        with open(dest_dir / name, "wb") as buf:
            shutil.copyfileobj(file.file, buf)

        return UploadResponse(
            success=True,
            filename=name,
            message=f"'{name}' uploaded successfully",
        )

    def upload_multiple_files(self, files: List[UploadFile]) -> MultiUploadResponse:
        """Upload multiple files, collecting per-file results without raising on failure."""
        results: List[UploadFileResult] = []

        for file in files:
            name = file.filename or ""
            try:
                self.upload_file(file)
                results.append(UploadFileResult(filename=name, success=True, message="Uploaded successfully"))
            except HTTPException as exc:
                results.append(UploadFileResult(filename=name, success=False, message=exc.detail))
            except Exception as exc:
                results.append(UploadFileResult(filename=name, success=False, message=str(exc)))

        uploaded = sum(1 for r in results if r.success)
        return MultiUploadResponse(
            uploaded=uploaded,
            failed=len(results) - uploaded,
            results=results,
        )

    # ------------------------------------------------------------------
    # Convert
    # ------------------------------------------------------------------

    def convert_to_markdown(
        self,
        filename: str,
        converter_type: ConverterType = ConverterType.pymupdf,
        vlm_settings: Optional[VLMSettings] = None,
    ) -> ConvertResponse:
        """Convert a stored PDF to Markdown and persist the result.

        Args:
            filename:       Name of the PDF in PDFS_DIR.
            converter_type: Which converter engine to use.
            vlm_settings:   Optional VLM overrides (model / base_url / api_key).
                            Ignored unless converter_type == ConverterType.vlm.
        """
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        def _on_progress(current: int, total: int) -> None:
            progress_store.update(filename, current, total)

        progress_store.start(filename)
        try:
            converter = _build_converter(
                converter_type,
                vlm_settings,
                on_progress=_on_progress if converter_type in (ConverterType.vlm, ConverterType.minimax) else None,
            )
            md_content = converter.convert(pdf_path)
        finally:
            progress_store.finish(filename)

        MDS_DIR.mkdir(parents=True, exist_ok=True)
        md_filename = f"{_stem(filename)}.md"
        (MDS_DIR / md_filename).write_text(md_content, encoding="utf-8")

        return ConvertResponse(
            success=True,
            md_filename=md_filename,
            message=f"Converted '{filename}' to Markdown using {converter_type.value}",
            md_content=md_content,
        )

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def convert_md_to_pdf(self, md_filename: str) -> MdToPdfResponse:
        """Convert a stored Markdown file to PDF using weasyprint."""
        from backend.utils.md_to_pdf import _convert_file

        md_path = MDS_DIR / md_filename
        if not md_path.exists():
            raise HTTPException(status_code=404, detail=f"MD '{md_filename}' not found")

        PDFS_DIR.mkdir(parents=True, exist_ok=True)
        pdf_filename = f"{_stem(md_filename)}.pdf"
        pdf_path = PDFS_DIR / pdf_filename

        success = _convert_file(md_path, pdf_path)
        if not success:
            raise HTTPException(status_code=500, detail="MD to PDF conversion failed")

        return MdToPdfResponse(
            success=True,
            pdf_filename=pdf_filename,
            message=f"Converted '{md_filename}' to PDF",
        )

    def delete_document(self, filename: str) -> DeleteResponse:
        """Delete a document and all its derived files (Markdown, chunks).

        Handles both PDF files and MD-only files. Raises 404 if not found.
        """
        ext = Path(filename).suffix.lower()
        deleted: List[str] = []
        stem = _stem(filename)

        if ext == ".md":
            # MD-only file: delete the MD and any associated chunks
            md_path = MDS_DIR / filename
            if not md_path.exists():
                raise HTTPException(status_code=404, detail=f"MD '{filename}' not found")
            md_path.unlink()
            deleted.append(str(md_path))

            chunks_path = CHUNKS_DIR / stem
            if chunks_path.exists():
                shutil.rmtree(chunks_path)
                deleted.append(str(chunks_path))

            associated = len(deleted) - 1
            return DeleteResponse(
                success=True,
                deleted=deleted,
                message=f"Deleted '{filename}' and {associated} associated file(s)",
            )

        # Default: PDF file
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        pdf_path.unlink()
        deleted.append(str(pdf_path))

        md_path = MDS_DIR / f"{stem}.md"
        if md_path.exists():
            md_path.unlink()
            deleted.append(str(md_path))

        chunks_path = CHUNKS_DIR / stem
        if chunks_path.exists():
            shutil.rmtree(chunks_path)
            deleted.append(str(chunks_path))

        associated = len(deleted) - 1  # exclude the PDF itself
        return DeleteResponse(
            success=True,
            deleted=deleted,
            message=f"Deleted '{filename}' and {associated} associated file(s)",
        )

    def delete_multiple_documents(self, filenames: List[str]) -> DeleteResponse:
        """Delete multiple documents, collecting errors without short-circuiting.

        Raises 404 only when *every* requested file is missing.
        """
        all_deleted: List[str] = []
        errors: List[str] = []

        for filename in filenames:
            try:
                result = self.delete_document(filename)
                all_deleted.extend(result.deleted)
            except HTTPException as exc:
                errors.append(f"{filename}: {exc.detail}")

        if errors and not all_deleted:
            raise HTTPException(status_code=404, detail="; ".join(errors))

        deleted_count = len(filenames) - len(errors)
        message = f"Deleted {deleted_count} document(s)"
        if errors:
            message += f"; {len(errors)} not found: {', '.join(errors)}"

        return DeleteResponse(
            success=len(errors) == 0,
            deleted=all_deleted,
            message=message,
        )