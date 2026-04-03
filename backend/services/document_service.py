"""
Document service — orchestrates PDF upload, conversion, and deletion.

# VERSION 3 — Unified ProcessPoolExecutor for all CPU-bound converters
#
# All CPU-bound converters (PyMuPDF, Docling, MarkItDown) now run in a shared
# ProcessPoolExecutor via convert_in_process(). VLM remains thread-based (I/O).
# Worker processes are initialised once via _init_cpu_worker() which pre-loads
# the DocumentService and Docling ML models, avoiding per-job reload cost.
# Top-level functions are required because child processes serialise them via
# pickle, which does not support local/nested functions.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from pathlib import Path
from typing import Callable, List, Optional, Type

from backend.config import get_settings

logger = logging.getLogger(__name__)

from fastapi import HTTPException, UploadFile

from backend.converters.base import PDFConverter
from backend.converters.docling import DoclingConverter
from backend.converters.liteparse import LiteParseConverter
from backend.converters.markitdown import MarkItDownConverter
from backend.converters.pymupdf import PyMuPDFConverter
from backend.converters.vlm import VLMConverter
from backend.models.schemas import (
    ConvertResponse,
    ConverterType,
    DeleteResponse,
    DocumentInfo,
    MdToPdfResponse,
    MultiUploadResponse,
    UploadFileResult,
    VLMSettings,
)

_ALLOWED_EXTENSIONS = {".pdf", ".md"}


# ---------------------------------------------------------------------------
# Top-level worker functions for ProcessPoolExecutor
#
# These MUST be top-level (not methods or lambdas) because they are serialised
# via pickle when submitted to the ProcessPoolExecutor.
# ---------------------------------------------------------------------------

# Module-level service instance used exclusively inside worker processes.
# Populated by _init_cpu_worker() which runs once when each worker starts.
_worker_svc: "DocumentService | None" = None


def _init_cpu_worker() -> None:
    """Initializer executed once per worker process at startup.

    Configures logging (child processes do not inherit the parent's logging
    setup) and pre-loads the DocumentService plus the Docling ML models so
    that the first real conversion job does not pay the 2-10s model-load cost.
    """
    import logging as _logging
    _logging.basicConfig(
        level=_logging.INFO,
        format="%(asctime)s [%(processName)s] %(levelname)s %(name)s — %(message)s",
    )

    global _worker_svc
    _worker_svc = DocumentService()

    # Pre-warm Docling: importing and instantiating DocumentConverter loads all
    # ML model weights into memory. Subsequent calls reuse the cached weights.
    try:
        from docling.document_converter import DocumentConverter
        DocumentConverter()
    except Exception:
        pass  # Docling not installed — silently skip pre-warm


def convert_in_process(filename: str, converter_type: ConverterType) -> ConvertResponse:
    """Run a CPU-bound PDF→Markdown conversion in a worker process.

    Handles PyMuPDF, Docling, and MarkItDown — all CPU-bound converters that
    benefit from process isolation (memory, thread-safety, GIL avoidance).
    VLM is intentionally excluded: it is I/O-bound (HTTP calls) and runs in a
    thread instead.

    Uses the module-level _worker_svc pre-created by _init_cpu_worker so that
    heavy state (e.g. Docling ML models) is loaded once per worker lifetime,
    not once per job.
    """
    if _worker_svc is None:
        raise RuntimeError("Worker process not initialised — _init_cpu_worker did not complete")
    return _worker_svc.convert_to_markdown(filename, converter_type=converter_type)


def convert_md_to_pdf_in_process(md_filename: str) -> MdToPdfResponse:
    """Run a Markdown→PDF conversion in a worker process.

    WeasyPrint (HTML layout + PDF rendering) is CPU-bound and holds the GIL
    for its entire duration, so running it in the shared process pool gives
    true parallelism and memory isolation from the main process.

    Uses the module-level _worker_svc pre-created by _init_cpu_worker.
    """
    if _worker_svc is None:
        raise RuntimeError("Worker process not initialised — _init_cpu_worker did not complete")
    return _worker_svc.convert_md_to_pdf(md_filename)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_filename(filename: str, description: str = "filename") -> str:
    """Reject any filename that contains path separators or traversal sequences.

    Accepts only a bare filename (no directory components). Raises HTTP 400
    if the value would escape the intended storage directory.
    """
    try:
        name = Path(filename).name
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {description} '{filename}'.",
        )
    if not name or name != filename or name in (".", ".."):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {description} '{filename}': path traversal is not allowed.",
        )
    return name


def _stem(filename: str) -> str:
    return Path(filename).stem


def _dest_dir(filename: str, pdfs_dir: Path, mds_dir: Path) -> Path:
    """Return the target directory for a given filename, or raise 400."""
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        return pdfs_dir
    if ext == ".md":
        return mds_dir
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported file type '{ext}'. Allowed: .pdf, .md",
    )


def _build_converter(
    converter_type: ConverterType,
    vlm_settings: Optional[VLMSettings],
    on_progress: Optional[Callable[[int, int], None]] = None,
    stop_event: Optional[threading.Event] = None,
) -> PDFConverter:
    """Instantiate the requested converter, forwarding VLM settings when relevant.

    Note: VLMConverter manages its own httpx.AsyncClient internally (bound to
    the private event loop created by asyncio.run inside convert()), so no
    shared http_client is accepted or passed here.
    """
    if converter_type == ConverterType.vlm:
        kwargs: dict = vlm_settings.model_dump(exclude_none=True) if vlm_settings else {}
        if on_progress:
            kwargs["on_progress"] = on_progress
        if stop_event is not None:
            kwargs["stop_event"] = stop_event
        return VLMConverter(**kwargs)

    return _CONVERTER_MAP[converter_type]()


# Converter registry — maps enum value to class (excludes VLM which needs args)
_CONVERTER_MAP: dict[ConverterType, Type[PDFConverter]] = {
    ConverterType.pymupdf: PyMuPDFConverter,
    ConverterType.docling: DoclingConverter,
    ConverterType.markitdown: MarkItDownConverter,
    ConverterType.liteparse: LiteParseConverter,
}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class DocumentService:
    """Handles all document-level operations: listing, uploading, converting, deleting."""

    def __init__(self) -> None:
        # Storage paths resolved at construction time so that env-var overrides
        # applied after module import (e.g. in tests) are picked up correctly.
        s = get_settings()
        self._pdfs_dir = Path(s.PDFS_DIR)
        self._mds_dir = Path(s.MDS_DIR)
        self._chunks_dir = Path(s.CHUNKS_DIR)

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def list_documents(self) -> List[str]:
        """Return a sorted list of all available documents (PDFs + MD-only files)."""
        results: List[str] = []
        pdf_stems: set = set()

        if self._pdfs_dir.exists():
            for f in self._pdfs_dir.glob("*.pdf"):
                results.append(f.name)
                pdf_stems.add(f.stem)

        # Include MD files that have no matching PDF
        if self._mds_dir.exists():
            for f in self._mds_dir.glob("*.md"):
                if f.stem not in pdf_stems:
                    results.append(f.name)

        return sorted(results)

    def list_documents_metadata(self) -> list[dict]:
        """Return a list of ``{filename, has_markdown}`` dicts for every document.

        This is a cheap stat-only scan — it does NOT read file contents.
        """
        results = []
        pdf_stems: set[str] = set()

        if self._pdfs_dir.exists():
            for f in sorted(self._pdfs_dir.glob("*.pdf")):
                md_path = self._mds_dir / f"{f.stem}.md"
                results.append({"filename": f.name, "has_markdown": md_path.exists()})
                pdf_stems.add(f.stem)

        if self._mds_dir.exists():
            for f in sorted(self._mds_dir.glob("*.md")):
                if f.stem not in pdf_stems:
                    results.append({"filename": f.name, "has_markdown": True})

        return results

    def get_document(self, filename: str) -> DocumentInfo:
        """Return metadata and existing Markdown content for a PDF or MD-only file."""
        filename = _safe_filename(filename, "document name")
        ext = Path(filename).suffix.lower()

        if ext == ".md":
            md_path = self._mds_dir / filename
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
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        md_filename = f"{_stem(filename)}.md"
        md_path = self._mds_dir / md_filename
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
        filename = _safe_filename(filename, "PDF filename")
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")
        return pdf_path

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def upload_file(self, file: UploadFile) -> None:
        """Persist a single uploaded PDF or Markdown file.

        Storage layout:
        - .pdf → docs/pdfs/
        - .md  → docs/mds/

        Raises HTTP 422 when:
        - The file exceeds MAX_FILE_SIZE_MB.
        - A .pdf file fails the magic-bytes check (not a real PDF).
        """
        import filetype

        name = _safe_filename(file.filename or "", "upload filename")
        dest_dir = _dest_dir(name, self._pdfs_dir, self._mds_dir)  # raises 400 for unsupported extensions
        dest_dir.mkdir(parents=True, exist_ok=True)

        settings = get_settings()
        max_bytes = settings.MAX_FILE_SIZE_MB * 1024 * 1024

        dest_path = dest_dir / name
        size = 0
        buf_for_magic = bytearray()
        is_pdf_ext = name.lower().endswith(".pdf")

        try:
            with open(dest_path, "wb") as out:
                while True:
                    chunk = file.file.read(65_536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if max_bytes > 0 and size > max_bytes:
                        out.close()
                        dest_path.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"'{name}' exceeds the {settings.MAX_FILE_SIZE_MB} MB upload limit "
                                f"({size // (1024 * 1024)} MB received so far)."
                            ),
                        )
                    # Collect the first 512 bytes for magic-byte detection.
                    if len(buf_for_magic) < 512:
                        buf_for_magic.extend(chunk[: 512 - len(buf_for_magic)])
                    out.write(chunk)
        except HTTPException:
            raise
        except Exception as exc:
            dest_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Failed to write '{name}': {exc}") from exc

        # Magic-bytes check: only for files uploaded with a .pdf extension.
        if is_pdf_ext:
            kind = filetype.guess(bytes(buf_for_magic))
            if kind is None or kind.mime != "application/pdf":
                dest_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=422,
                    detail=f"'{name}' does not appear to be a valid PDF (magic bytes mismatch).",
                )

        logger.info(
            "Uploaded '%s' (%d KB)",
            name,
            size // 1024,
            extra={"operation": "upload", "file_name": name},
        )

    def upload_files(self, files: List[UploadFile]) -> MultiUploadResponse:
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
        stop_event: Optional[threading.Event] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> ConvertResponse:
        """Convert a stored PDF to Markdown and persist the result.

        Args:
            filename:       Name of the PDF in the configured pdfs directory.
            converter_type: Which converter engine to use.
            vlm_settings:   Optional VLM overrides (model / base_url / api_key).
                            Ignored unless converter_type == ConverterType.vlm.
            stop_event:     Optional threading.Event; when set, the VLM page
                            loop raises InterruptedError between pages to allow
                            a clean cancellation without waiting for the full run.
            on_progress:    Optional callback called after each VLM page with
                            (current_page, total_pages).  Only fired for VLM
                            conversions; other converters have no page-level steps.
        """
        filename = _safe_filename(filename, "PDF filename")
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        settings = get_settings()

        # Page count guard — open the PDF once to read page count, then reuse
        # the value so the converter (especially VLMConverter) does not need to
        # open the file a second time.
        page_count: Optional[int] = None
        try:
            import fitz  # PyMuPDF
            with fitz.open(str(pdf_path)) as doc:
                page_count = doc.page_count
            if settings.MAX_PAGE_COUNT > 0 and page_count > settings.MAX_PAGE_COUNT:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"'{filename}' has {page_count} pages, which exceeds the "
                        f"configured limit of {settings.MAX_PAGE_COUNT}."
                    ),
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("Could not read page count for '%s': %s", filename, exc, exc_info=True)

        def _progress_handler(current: int, total: int) -> None:
            if on_progress:
                on_progress(current, total)
            if stop_event and stop_event.is_set():
                raise InterruptedError("Conversion cancelled by client disconnect")

        logger.info(
            "Starting conversion of '%s' with converter '%s'",
            filename,
            converter_type.value,
            extra={"operation": "convert", "file_name": filename},
        )
        t0 = time.monotonic()
        try:
            converter = _build_converter(
                converter_type,
                vlm_settings,
                on_progress=_progress_handler if converter_type == ConverterType.vlm else None,
                stop_event=stop_event if converter_type == ConverterType.vlm else None,
            )
            md_content = converter.convert(pdf_path, total_pages=page_count)
        except InterruptedError:
            logger.info(
                "Conversion of '%s' was cancelled after %.0f ms",
                filename,
                (time.monotonic() - t0) * 1000,
                extra={"operation": "convert", "file_name": filename},
            )
            raise

        self._mds_dir.mkdir(parents=True, exist_ok=True)
        md_filename = f"{_stem(filename)}.md"
        (self._mds_dir / md_filename).write_text(md_content, encoding="utf-8")

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "Conversion complete: '%s' → '%s' in %d ms",
            filename,
            md_filename,
            elapsed_ms,
            extra={"operation": "convert", "file_name": filename, "duration_ms": elapsed_ms},
        )
        return ConvertResponse(
            success=True,
            md_filename=md_filename,
            message=f"Converted '{filename}' to Markdown using {converter_type.value}",
            md_content=md_content,
        )

    # ------------------------------------------------------------------
    # Convert MD → PDF
    # ------------------------------------------------------------------

    def convert_md_to_pdf(self, md_filename: str) -> MdToPdfResponse:
        """Convert a stored Markdown file to PDF using weasyprint."""
        from backend.utils.md_to_pdf import _convert_file

        md_filename = _safe_filename(md_filename, "Markdown filename")
        md_path = self._mds_dir / md_filename
        if not md_path.exists():
            raise HTTPException(status_code=404, detail=f"MD '{md_filename}' not found")

        self._pdfs_dir.mkdir(parents=True, exist_ok=True)
        pdf_filename = f"{_stem(md_filename)}.pdf"
        pdf_path = self._pdfs_dir / pdf_filename

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
        filename = _safe_filename(filename, "document name")
        ext = Path(filename).suffix.lower()
        deleted: List[str] = []
        stem = _stem(filename)

        if ext == ".md":
            # MD-only file: delete the MD and any associated chunks
            md_path = self._mds_dir / filename
            if not md_path.exists():
                raise HTTPException(status_code=404, detail=f"MD '{filename}' not found")
            md_path.unlink()
            deleted.append(str(md_path))

            chunks_path = self._chunks_dir / stem
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
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        pdf_path.unlink()
        deleted.append(str(pdf_path))

        md_path = self._mds_dir / f"{stem}.md"
        if md_path.exists():
            md_path.unlink()
            deleted.append(str(md_path))

        chunks_path = self._chunks_dir / stem
        if chunks_path.exists():
            shutil.rmtree(chunks_path)
            deleted.append(str(chunks_path))

        associated = len(deleted) - 1  # exclude the PDF itself
        return DeleteResponse(
            success=True,
            deleted=deleted,
            message=f"Deleted '{filename}' and {associated} associated file(s)",
        )

    def delete_documents(self, filenames: List[str]) -> DeleteResponse:
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
            except OSError as exc:
                errors.append(f"{filename}: {exc}")

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
