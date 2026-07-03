"""
Document service — orchestrates PDF upload, conversion, and deletion.

CPU-bound converters run in a process pool owned by the current conversion
batch. VLM and Cloud remain thread-based because they are primarily I/O-bound.
Worker entry points are top-level because child processes serialise them via
pickle, which does not support local or nested functions.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Type

from backend.config import get_settings

logger = logging.getLogger(__name__)

from fastapi import HTTPException, UploadFile

from backend.converters.vlm_checkpoint import CheckpointStore, discard_all_for_stem
from backend.services.enrichment_checkpoint import discard_all_for_stem as discard_enrich_for_stem
from backend.services.document_summary import discard_all_for_stem as discard_summary_for_stem
from backend.converters.base import PDFConverter
from backend.converters.cloud import CloudConverter
from backend.converters.docling import DoclingConverter
from backend.converters.liteparse import LiteParseConverter
from backend.converters.markitdown import MarkItDownConverter
from backend.converters.pymupdf import PyMuPDFConverter
from backend.converters.vlm import VLMConverter
from backend.models.schemas import (
    CloudSettings,
    ConvertPreviewResponse,
    ConvertResponse,
    ConverterType,
    DeleteResponse,
    DocumentInfo,
    MarkdownContentResponse,
    MarkdownVersion,
    MdToPdfResponse,
    MultiUploadResponse,
    UploadFileResult,
    VLMSettings,
)
from backend.services.chunk_storage_service import delete_chunks_for_markdown
from backend.services.document_files import (
    document_stem_for_markdown,
    file_has_failure_markers as _file_has_failure_markers,
    find_markdown_for_document,
    markdown_belongs_to_stem as _markdown_belongs_to_stem,
    md_files_for_stem as _md_files_for_stem,
    preferred_markdown_for_stem as _preferred_markdown_for_stem,
)
from backend.utils.naming import (
    KNOWN_CONVERTERS as _KNOWN_CONVERTERS,
    normalise_converter as _normalise_converter,
)
from backend.utils.path import safe_child_path, safe_filename, safe_stem
from backend.utils.files import atomic_write_text

# ---------------------------------------------------------------------------
# Top-level worker functions for ProcessPoolExecutor
# ---------------------------------------------------------------------------

_worker_svc: "DocumentService | None" = None


def _init_cpu_worker() -> None:
    """Initialize the document service in a CPU worker process."""
    import logging as _logging
    _logging.basicConfig(
        level=_logging.INFO,
        format="%(asctime)s [%(processName)s] %(levelname)s %(name)s — %(message)s",
    )

    global _worker_svc
    _worker_svc = DocumentService()


def convert_in_process(
    filename: str,
    converter_type: ConverterType,
    force: bool = False,
) -> ConvertResponse:
    """Run a CPU-bound PDF→Markdown conversion in a worker process."""
    if _worker_svc is None:
        raise RuntimeError("Worker process not initialised — _init_cpu_worker did not complete")
    return _worker_svc.convert_to_markdown(
        filename,
        converter_type=converter_type,
        force=force,
    )


def preview_in_process(
    filename: str,
    converter_type: ConverterType,
    start_page: int,
    end_page: int,
) -> ConvertPreviewResponse:
    """Run a CPU-bound read-only PDF→Markdown preview in a worker process."""
    if _worker_svc is None:
        raise RuntimeError("Worker process not initialised — _init_cpu_worker did not complete")
    return _worker_svc.preview_conversion(
        filename,
        converter_type=converter_type,
        start_page=start_page,
        end_page=end_page,
    )


def render_markdown_pdf_in_process(md_path: str, temp_pdf_path: str) -> bool:
    """Render Markdown into a caller-owned temporary PDF file."""
    from backend.scripts.md_to_pdf import _convert_file

    return _convert_file(Path(md_path), Path(temp_pdf_path))


def create_pdf_temp_path(pdf_path: Path) -> Path:
    """Reserve a unique same-directory temporary path for atomic publication."""
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(
        dir=pdf_path.parent,
        prefix=f".{pdf_path.name}.",
        suffix=".tmp.pdf",
    )
    os.close(fd)
    return Path(name)


def publish_pdf_without_overwrite(temp_path: Path, pdf_path: Path) -> None:
    """Atomically publish a PDF while refusing to replace an existing file."""
    try:
        os.link(temp_path, pdf_path)
    except FileExistsError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"PDF '{pdf_path.name}' already exists; refusing to overwrite it.",
        ) from exc
    finally:
        temp_path.unlink(missing_ok=True)


def _slice_pdf_pages(pdf_path: Path, start_page: int, end_page: int) -> tuple[Path, int]:
    """Copy a 1-indexed inclusive page range into a caller-deleted temp PDF."""
    import fitz

    with fitz.open(str(pdf_path)) as source:
        page_count = source.page_count
        if start_page > end_page:
            raise HTTPException(status_code=422, detail="start_page must be less than or equal to end_page.")
        if end_page > page_count:
            raise HTTPException(
                status_code=422,
                detail=f"end_page {end_page} exceeds '{pdf_path.name}' page count ({page_count}).",
            )

        fd, temp_name = tempfile.mkstemp(prefix=f"{pdf_path.stem}_preview_", suffix=".pdf")
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            with fitz.open() as preview:
                preview.insert_pdf(source, from_page=start_page - 1, to_page=end_page - 1)
                preview.save(str(temp_path))
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    return temp_path, page_count


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stem(filename: str) -> str:
    return Path(filename).stem


def _dest_dir(filename: str, pdfs_dir: Path, mds_dir: Path) -> Path:
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        return pdfs_dir
    if ext == ".md":
        return mds_dir
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported file type '{ext}'. Allowed: .pdf, .md",
    )


def _converter_suffix_owner(md_filename: str) -> str | None:
    """Return the apparent PDF stem of ``{stem}_{converter}.md`` names."""
    md_stem = Path(md_filename).stem
    owner_stem, separator, converter = md_stem.rpartition("_")
    if separator and owner_stem and converter in _KNOWN_CONVERTERS:
        return owner_stem
    return None


_PAGE_SECTION_RE = re.compile(
    r"(?ms)(?P<marker><!--\s*page-marker:(?P<page>\d+)\s*-->\n?)"
    r"(?P<body>.*?)(?=(?:\n\n---\n\n)?<!--\s*page-marker:\d+\s*-->|\Z)"
)
_FAILED_PAGE_RE = re.compile(r"<!--\s*page\s+(?P<page>\d+)\s+failed:")


def _replace_failed_pages_from_checkpoint(
    md_path: Path,
    checkpoint_store: CheckpointStore,
) -> int:
    """Patch stale VLM failure placeholders with newly checkpointed pages.

    During a "retry failed pages" run, every successful page is written to the
    VLM checkpoint immediately. If the user interrupts before the whole retry
    finishes, the final Markdown file is intentionally not republished — but
    leaving old ``<!-- page N failed -->`` placeholders for pages that now have
    successful checkpoint content makes the UI report stale failures. This
    helper updates only those already-failed sections whose page now exists in
    the checkpoint, preserving all other content and failure placeholders.
    """
    try:
        original = md_path.read_text(encoding="utf-8")
    except OSError:
        return 0

    completed_pages = set(checkpoint_store.completed_pages())
    if not completed_pages:
        return 0

    replacements = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal replacements
        page_num = int(match.group("page"))
        zero_indexed = page_num - 1
        body = match.group("body")
        failed_marker = _FAILED_PAGE_RE.search(body)
        if (
            zero_indexed not in completed_pages
            or failed_marker is None
            or int(failed_marker.group("page")) != page_num
        ):
            return match.group(0)

        try:
            cached_markdown = checkpoint_store.load_page(zero_indexed)
        except OSError as exc:
            logger.warning(
                "Failed to load checkpoint for page %d while reconciling '%s': %s",
                page_num,
                md_path.name,
                exc,
            )
            return match.group(0)

        marker = match.group("marker")
        if not marker.endswith("\n"):
            marker += "\n"
        replacements += 1
        return f"{marker}{cached_markdown}"

    updated = _PAGE_SECTION_RE.sub(replace, original)
    if replacements and updated != original:
        atomic_write_text(md_path, updated)
    return replacements


def _build_converter(
    converter_type: ConverterType,
    vlm_settings: VLMSettings | None,
    cloud_settings: CloudSettings | None,
    on_progress: Callable[[int, int], None] | None = None,
    stop_event: threading.Event | None = None,
    checkpoint_store: CheckpointStore | None = None,
) -> PDFConverter:
    """Instantiate the requested converter, forwarding runtime settings when relevant."""
    if converter_type == ConverterType.vlm:
        kwargs: dict = vlm_settings.model_dump(exclude_none=True) if vlm_settings else {}
        # ``use_checkpoint`` is a service-level flag (controls whether the
        # checkpoint store is constructed/cleared) and is not part of
        # VLMConverter's constructor signature.  Drop it before unpacking so
        # the converter doesn't reject the kwarg.
        kwargs.pop("use_checkpoint", None)
        if on_progress:
            kwargs["on_progress"] = on_progress
        if stop_event is not None:
            kwargs["stop_event"] = stop_event
        if checkpoint_store is not None:
            kwargs["checkpoint_store"] = checkpoint_store
        return VLMConverter(**kwargs)

    if converter_type == ConverterType.cloud:
        kwargs = cloud_settings.model_dump(exclude_none=True) if cloud_settings else {}
        if on_progress:
            kwargs["on_progress"] = on_progress
        if stop_event is not None:
            kwargs["stop_event"] = stop_event
        return CloudConverter(**kwargs)

    return _CONVERTER_MAP[converter_type]()


# Converter registry — maps enum value to class (excludes VLM and Cloud which need runtime args)
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
        s = get_settings()
        self._pdfs_dir = Path(s.PDFS_DIR)
        self._mds_dir = Path(s.MDS_DIR)
        self._chunks_dir = Path(s.CHUNKS_DIR)

    # ------------------------------------------------------------------
    # Cleanup helpers
    # ------------------------------------------------------------------

    def _discard_derived_caches(self, stem: str) -> None:
        """Wipe every on-disk cache derived from a source document.

        Centralises the three cascade calls (VLM checkpoints, enrichment
        checkpoints, document summaries) so adding a new cache tier later
        only has to be wired into one place — call sites (upload-overwrite,
        delete) can't accidentally forget one of the three.  Each underlying
        ``discard_all_for_stem`` is independently best-effort: I/O failures
        are logged but never raised, so cleanup of one tier never blocks
        the others.
        """
        discard_all_for_stem(stem, self._mds_dir)
        discard_enrich_for_stem(stem, self._mds_dir)
        discard_summary_for_stem(stem, self._mds_dir)

    def _discard_markdown_variant_caches(
        self,
        md_filename: str,
        *,
        document_name: str | None = None,
    ) -> None:
        """Wipe caches owned by one Markdown file.

        Converted Markdown variants use two different stems on disk:
        enrichment checkpoints are keyed by the Markdown stem
        (``report_vlm_enrich``), while VLM page checkpoints are keyed by the
        source document stem plus converter token (``report_vlm``).  Deleting
        a single variant should remove those variant-scoped caches without
        deleting the shared document summary used by sibling variants.
        """
        md_stem = _stem(md_filename)
        try:
            doc_stem = document_stem_for_markdown(document_name, md_filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if md_stem == doc_stem:
            self._discard_derived_caches(md_stem)
            return

        discard_enrich_for_stem(md_stem, self._mds_dir)
        discard_summary_for_stem(md_stem, self._mds_dir)
        if md_stem == f"{doc_stem}_vlm":
            CheckpointStore(doc_stem, self._mds_dir).discard()

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def _is_md_associated_with_pdf(self, md_file: Path, pdf_stems: set[str]) -> bool:
        """True if *md_file* belongs to one of the PDFs identified by *pdf_stems*.

        A file belongs to a PDF when its stem either equals the PDF stem
        exactly (direct upload) or starts with ``{pdf_stem}_`` and
        the trailing token is a known converter name.
        """
        return any(_markdown_belongs_to_stem(md_file, pdf_stem) for pdf_stem in pdf_stems)

    def list_documents(self) -> list[str]:
        results: list[str] = []
        pdf_stems: set[str] = set()

        if self._pdfs_dir.exists():
            for f in self._pdfs_dir.glob("*.pdf"):
                results.append(f.name)
                pdf_stems.add(f.stem)

        if self._mds_dir.exists():
            for f in self._mds_dir.glob("*.md"):
                if not self._is_md_associated_with_pdf(f, pdf_stems):
                    results.append(f.name)

        return sorted(results)

    def list_documents_metadata(self) -> list[dict]:
        """Return per-document metadata for the sidebar listing.

        ``has_failures`` is true when the VLM Markdown variant on disk
        contains one or more ``<!-- page N failed: … -->`` placeholders.
        That state has a visible Markdown preview.

        ``has_checkpoint`` is true when a VLM checkpoint directory survives
        on disk.  That usually means a manually interrupted run can be
        resumed, but the cached pages may not have been published as a
        Markdown preview yet.  Keeping the two signals separate lets the UI
        avoid presenting an interrupted checkpoint like a saved partial
        Markdown file.
        """
        results = []
        pdf_stems: set[str] = set()

        if self._pdfs_dir.exists():
            for f in sorted(self._pdfs_dir.glob("*.pdf")):
                stem = f.stem
                has_md = bool(_md_files_for_stem(self._mds_dir, stem))
                has_checkpoint = CheckpointStore(stem, self._mds_dir).exists()
                vlm_md = self._mds_dir / f"{stem}_vlm.md"
                has_failures = vlm_md.exists() and _file_has_failure_markers(vlm_md)
                results.append({
                    "filename": f.name,
                    "has_markdown": has_md,
                    "has_failures": has_failures,
                    "has_checkpoint": has_checkpoint,
                })
                pdf_stems.add(stem)

        if self._mds_dir.exists():
            for f in sorted(self._mds_dir.glob("*.md")):
                if not self._is_md_associated_with_pdf(f, pdf_stems):
                    # Standalone .md uploads can't have a VLM checkpoint —
                    # they were never produced by a per-page converter.
                    results.append({
                        "filename": f.name,
                        "has_markdown": True,
                        "has_failures": False,
                        "has_checkpoint": False,
                    })

        return results

    def get_document(self, filename: str) -> DocumentInfo:
        filename = safe_filename(filename, "document name")
        ext = Path(filename).suffix.lower()

        if ext == ".md":
            md_path = self._mds_dir / filename
            if not md_path.exists():
                raise HTTPException(status_code=404, detail=f"MD '{filename}' not found")
            md_content = md_path.read_text(encoding="utf-8")
            pdf_filename = f"{_stem(filename)}.pdf"
            has_pdf = (self._pdfs_dir / pdf_filename).exists()
            return DocumentInfo(
                pdf_filename=pdf_filename,
                md_filename=filename,
                md_content=md_content,
                has_markdown=True,
                has_pdf=has_pdf,
            )

        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        # Pick the first available Markdown variant for this PDF as the
        # "default" version returned in DocumentInfo.  The caller can switch
        # to other versions using GET /documents/{name}/markdowns.
        stem = _stem(filename)
        chosen = _preferred_markdown_for_stem(self._mds_dir, stem)
        if chosen:
            md_filename = chosen.name
            md_content = chosen.read_text(encoding="utf-8")
            has_markdown = True
        else:
            # No file yet — surface a placeholder filename so existing
            # frontend logic (which uses md_filename for save targets) keeps
            # working until the user converts.
            md_filename = f"{stem}.md"
            md_content = ""
            has_markdown = False

        return DocumentInfo(
            pdf_filename=filename,
            md_filename=md_filename,
            md_content=md_content,
            has_markdown=has_markdown,
            has_pdf=True,
        )

    def list_markdown_versions(self, document_name: str) -> list[MarkdownVersion]:
        """Return every Markdown version on disk for *document_name*.

        ``document_name`` may be a PDF filename, an MD filename, or a bare
        stem.  Converted versions are reported with ``source="converted"``
        and the parsed converter token; uploaded files (whose name does not
        match the ``{stem}_{converter}.md`` pattern) are reported with
        ``source="uploaded"`` and ``converter=None``.

        Each version also carries ``has_failures``: true iff the file
        contains one or more ``<!-- page N failed: … -->`` placeholders
        emitted by the VLM converter after a partial run.  The frontend
        version picker uses this flag to mark the affected variant so the
        user can tell at a glance which one is incomplete.
        """
        stem = safe_stem(document_name)
        if not self._mds_dir.exists():
            return []

        versions: list[MarkdownVersion] = []
        # Converted variants
        for converter in sorted(_KNOWN_CONVERTERS):
            candidate = self._mds_dir / f"{stem}_{converter}.md"
            if candidate.exists():
                versions.append(MarkdownVersion(
                    filename=candidate.name,
                    source="converted",
                    converter=converter,
                    has_failures=_file_has_failure_markers(candidate),
                ))

        # Direct upload: only the exact ``{stem}.md`` file. Other files
        # that merely share the prefix (``report_notes.md``, ``report2.md``)
        # are separate documents, not versions of this one.
        for f in sorted(self._mds_dir.glob(f"{stem}*.md")):
            if f.stem == stem:
                versions.append(MarkdownVersion(
                    filename=f.name,
                    source="uploaded",
                    converter=None,
                    has_failures=_file_has_failure_markers(f),
                ))
                continue

        return versions

    def get_markdown_content(self, document_name: str, identifier: str) -> MarkdownContentResponse:
        """Return the content of one specific Markdown version.

        ``identifier`` may be either a converter name (resolves to
        ``{stem}_{identifier}.md``) or the original on-disk filename for
        uploaded MDs.  This dual lookup keeps the URL natural for both
        cases without exposing internal naming details to the client.
        """
        stem = safe_stem(document_name)

        # 1) Converter-name lookup
        if identifier in _KNOWN_CONVERTERS:
            candidate = safe_child_path(self._mds_dir, f"{stem}_{identifier}.md", description="identifier")
            if candidate.exists():
                return MarkdownContentResponse(
                    filename=candidate.name,
                    source="converted",
                    converter=identifier,
                    content=candidate.read_text(encoding="utf-8"),
                )

        # 2) Direct filename lookup
        if identifier.endswith(".md"):
            candidate = safe_child_path(self._mds_dir, identifier, description="identifier")
            if candidate.exists() and _markdown_belongs_to_stem(candidate, stem):
                # Determine source from the filename pattern
                suffix = candidate.stem[len(stem):]
                if suffix.startswith("_") and suffix[1:] in _KNOWN_CONVERTERS:
                    return MarkdownContentResponse(
                        filename=candidate.name,
                        source="converted",
                        converter=suffix[1:],
                        content=candidate.read_text(encoding="utf-8"),
                    )
                return MarkdownContentResponse(
                    filename=candidate.name,
                    source="uploaded",
                    converter=None,
                    content=candidate.read_text(encoding="utf-8"),
                )

        raise HTTPException(
            status_code=404,
            detail=f"Markdown version '{identifier}' not found for '{document_name}'",
        )

    def get_vlm_checkpoint_info(self, document_name: str) -> dict:
        """Return the VLM checkpoint state for ``document_name``.

        Used by the frontend to surface a "Resume available" indicator.  The
        document need not currently exist on disk — if the PDF was deleted
        with orphan checkpoint files left over (should not happen with the
        regular ``delete_document`` flow, but kept defensive), ``exists`` is
        reported truthfully and the caller can decide whether to discard.
        """
        stem = safe_stem(document_name)
        store = CheckpointStore(stem, self._mds_dir)
        # 1-indexed for the UI (page numbers shown to users start at 1).
        completed = [p + 1 for p in store.completed_pages()]
        return {
            "document_name": document_name,
            "converter": "vlm",
            "exists": bool(completed),
            "completed_pages": completed,
        }

    def save_markdown_content(
        self,
        document_name: str,
        md_filename: str,
        content: str,
    ) -> MarkdownContentResponse:
        """Persist an edited Markdown file under an explicit document owner."""
        document_name = safe_filename(document_name, "document name")
        md_filename = safe_filename(md_filename, "Markdown filename")
        try:
            owner_stem = document_stem_for_markdown(document_name, md_filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        md_path = self._mds_dir / md_filename
        if not md_path.is_file():
            raise HTTPException(status_code=404, detail=f"MD '{md_filename}' not found")
        atomic_write_text(md_path, content)
        delete_chunks_for_markdown(
            self._chunks_dir,
            md_filename,
            document_name=document_name,
        )
        self._discard_markdown_variant_caches(
            md_filename,
            document_name=document_name,
        )
        converter = None
        source = "uploaded"
        prefix = f"{owner_stem}_"
        if md_path.stem.startswith(prefix):
            token = md_path.stem[len(prefix):]
            if token in _KNOWN_CONVERTERS:
                converter = token
                source = "converted"
        return MarkdownContentResponse(
            filename=md_filename,
            source=source,
            converter=converter,
            content=content,
        )

    def get_pdf_path(self, filename: str) -> Path:
        filename = safe_filename(filename, "PDF filename")
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")
        return pdf_path

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def upload_file(self, file: UploadFile) -> str:
        import filetype

        name = safe_filename(file.filename or "", "upload filename")
        suffix = Path(name).suffix
        if suffix:
            name = str(Path(name).with_suffix(suffix.lower()))
        dest_dir = _dest_dir(name, self._pdfs_dir, self._mds_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)

        settings = get_settings()
        max_bytes = settings.MAX_FILE_SIZE_MB * 1024 * 1024
        read_chunk_bytes = settings.UPLOAD_READ_CHUNK_BYTES
        magic_probe_bytes = settings.PDF_MAGIC_PROBE_BYTES

        dest_path = dest_dir / name
        is_pdf_ext = name.lower().endswith(".pdf")
        if is_pdf_ext:
            # A standalone upload named ``notes_vlm.md`` must not silently
            # become the VLM variant of a later ``notes.pdf`` upload. Existing
            # PDFs are safe: their converter-suffixed Markdown files already
            # belong to that PDF and will be invalidated by the overwrite.
            if not dest_path.exists():
                stem = _stem(name)
                collisions = [
                    self._mds_dir / f"{stem}_{converter}.md"
                    for converter in _KNOWN_CONVERTERS
                    if (self._mds_dir / f"{stem}_{converter}.md").is_file()
                ]
                if collisions:
                    conflict = collisions[0].name
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"Cannot upload '{name}': standalone Markdown "
                            f"'{conflict}' would be mistaken for a converted "
                            "variant. Rename one of the files first."
                        ),
                    )
        else:
            apparent_owner = _converter_suffix_owner(name)
            if apparent_owner and (self._pdfs_dir / f"{apparent_owner}.pdf").is_file():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Cannot upload '{name}' as a standalone Markdown "
                        f"document while '{apparent_owner}.pdf' exists; its "
                        "name is reserved for that PDF's converted variant."
                    ),
                )

        size = 0
        buf_for_magic = bytearray()
        # Detect "uploading over an existing PDF" up-front; the actual stale-
        # derivative cleanup is deferred to after the new file is fully
        # written and validated so a failed upload doesn't destroy
        # converted artifacts that still match the previous on-disk PDF.
        was_overwrite = is_pdf_ext and dest_path.exists()
        was_md_overwrite = name.lower().endswith(".md") and dest_path.exists()
        temp_path: Path | None = None

        try:
            with tempfile.NamedTemporaryFile(
                "wb",
                delete=False,
                dir=dest_dir,
                prefix=f".{name}.",
                suffix=".upload",
            ) as out:
                temp_path = Path(out.name)
                while True:
                    chunk = file.file.read(read_chunk_bytes)
                    if not chunk:
                        break
                    size += len(chunk)
                    if max_bytes > 0 and size > max_bytes:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"'{name}' exceeds the {settings.MAX_FILE_SIZE_MB} MB upload limit "
                                f"({size // (1024 * 1024)} MB received so far)."
                            ),
                        )
                    if len(buf_for_magic) < magic_probe_bytes:
                        buf_for_magic.extend(chunk[: magic_probe_bytes - len(buf_for_magic)])
                    out.write(chunk)
        except HTTPException:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Failed to write '{name}': {exc}") from exc

        if is_pdf_ext:
            kind = filetype.guess(bytes(buf_for_magic))
            if kind is None or kind.mime != "application/pdf":
                if temp_path is not None:
                    temp_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=422,
                    detail=f"'{name}' does not appear to be a valid PDF (magic bytes mismatch).",
                )

        if temp_path is None:
            raise HTTPException(status_code=500, detail=f"Failed to write '{name}': no temporary file created")

        # Invalidate visible derivatives before publishing a replacement PDF.
        # Once the new source is visible, no Markdown/chunk file derived from
        # the old bytes may remain addressable under the same document name.
        if was_overwrite:
            stem = _stem(name)
            try:
                for md_file in _md_files_for_stem(self._mds_dir, stem):
                    md_file.unlink()
                chunks_path = self._chunks_dir / stem
                if chunks_path.exists():
                    shutil.rmtree(chunks_path)
            except OSError as exc:
                temp_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not invalidate stale derivatives before replacing '{name}': {exc}",
                ) from exc
            self._discard_derived_caches(stem)

        try:
            os.replace(temp_path, dest_path)
        except OSError as exc:
            temp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Failed to store '{name}': {exc}") from exc
        temp_path = None

        # The replacement and its derivative invalidation both succeeded.
        if was_overwrite:
            stem = _stem(name)
            logger.info(
                "Overwrote '%s' — wiped stale derivatives for stem '%s'",
                name, stem,
                extra={"operation": "upload", "file_name": name},
            )

        if was_md_overwrite:
            deleted_chunks = delete_chunks_for_markdown(
                self._chunks_dir,
                name,
                document_name=name,
            )
            self._discard_markdown_variant_caches(name, document_name=name)
            logger.info(
                "Overwrote '%s' — wiped %d stale chunk artifact(s) and markdown caches",
                name, len(deleted_chunks),
                extra={"operation": "upload", "file_name": name},
            )

        logger.info(
            "Uploaded '%s' (%d KB)",
            name,
            size // 1024,
            extra={"operation": "upload", "file_name": name},
        )
        return name

    def upload_files(self, files: list[UploadFile]) -> MultiUploadResponse:
        results: list[UploadFileResult] = []

        for file in files:
            name = file.filename or ""
            try:
                stored_name = self.upload_file(file)
                message = (
                    "Uploaded successfully"
                    if stored_name == name
                    else f"Uploaded successfully as '{stored_name}'"
                )
                results.append(UploadFileResult(filename=stored_name, success=True, message=message))
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
        vlm_settings: VLMSettings | None = None,
        cloud_settings: CloudSettings | None = None,
        stop_event: threading.Event | None = None,
        on_progress: Callable[[int, int], None] | None = None,
        force: bool = False,
    ) -> ConvertResponse:
        """Convert a stored PDF to Markdown and persist the result."""
        filename = safe_filename(filename, "PDF filename")
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        settings = get_settings()

        page_count: int | None = None
        try:
            import fitz
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
            logger.warning(
                "Could not read page count for '%s': %s", filename, exc, exc_info=True
            )

        def _progress_handler(current: int, total: int) -> None:
            if on_progress:
                on_progress(current, total)
            if stop_event and stop_event.is_set():
                raise InterruptedError("Conversion cancelled by client disconnect")

        # Build the per-converter Markdown filename now so we can short-circuit
        # if the same document+converter has already been converted before.
        stem = _stem(filename)
        converter_token = _normalise_converter(converter_type.value)
        md_filename = f"{stem}_{converter_token}.md"
        md_path = self._mds_dir / md_filename

        # VLM-only: prepare the checkpoint store and snapshot partial-run
        # signals BEFORE honouring the ``use_checkpoint`` opt-out.  A partial
        # result can be signalled either by cached successful pages or by
        # failure placeholders in the saved Markdown (notably when every page
        # failed and no checkpoint page was written).
        checkpoint_store: CheckpointStore | None = None
        had_partial_vlm_result = False
        if converter_type == ConverterType.vlm and md_path.exists():
            had_partial_vlm_result = _file_has_failure_markers(md_path)
        if converter_type == ConverterType.vlm and settings.VLM_CHECKPOINT_ENABLED:
            checkpoint_store = CheckpointStore(stem, self._mds_dir)
            had_partial_vlm_result = had_partial_vlm_result or checkpoint_store.exists()
            use_checkpoint = vlm_settings.use_checkpoint if vlm_settings is not None else True
            if not use_checkpoint:
                checkpoint_store.discard()

        # A stored Markdown alone normally means "already converted, reuse" —
        # but for VLM, any partial-run signal must force a rerun so failed
        # pages get another attempt instead of returning stale placeholders.
        # The check uses the pre-discard snapshot so ``use_checkpoint=False``
        # still triggers a fresh conversion when the previous run was partial.
        if md_path.exists() and not had_partial_vlm_result and not force:
            logger.info(
                "Skipping conversion of '%s' with '%s' — '%s' already exists",
                filename, converter_type.value, md_filename,
                extra={"operation": "convert", "file_name": filename},
            )
            return ConvertResponse(
                success=True,
                md_filename=md_filename,
                message=f"'{md_filename}' already exists — reusing on-disk content",
                md_content=md_path.read_text(encoding="utf-8"),
            )

        logger.info(
            "Starting conversion of '%s' with converter '%s'",
            filename,
            converter_type.value,
            extra={"operation": "convert", "file_name": filename},
        )
        t0 = time.monotonic()

        # I/O-bound converters (VLM, Cloud) receive stop_event and on_progress.
        # CPU-bound converters run in isolated processes and cannot accept these.
        _is_io_bound = converter_type in (ConverterType.vlm, ConverterType.cloud)

        try:
            converter = _build_converter(
                converter_type,
                vlm_settings,
                cloud_settings,
                on_progress=_progress_handler if _is_io_bound else None,
                stop_event=stop_event if _is_io_bound else None,
                checkpoint_store=checkpoint_store,
            )
            md_content = converter.convert(pdf_path, total_pages=page_count)
        except InterruptedError:
            if converter_type == ConverterType.vlm and checkpoint_store is not None and md_path.exists():
                replaced = _replace_failed_pages_from_checkpoint(md_path, checkpoint_store)
                if replaced:
                    logger.info(
                        "Reconciled %d VLM failed page placeholder(s) from checkpoint after cancellation of '%s'",
                        replaced,
                        filename,
                        extra={"operation": "convert", "file_name": filename},
                    )
            logger.info(
                "Conversion of '%s' was cancelled after %.0f ms",
                filename,
                (time.monotonic() - t0) * 1000,
                extra={"operation": "convert", "file_name": filename},
            )
            # Checkpoint is intentionally preserved on cancellation so the
            # next attempt can resume from the last persisted page.
            raise

        # ── Extract per-page outcome from the VLM converter ──────────────────
        # Other converters do not surface these attributes; default to None
        # so the response shape stays uniform but uninformative for them.
        failed_pages = getattr(converter, "failed_pages", None) or None
        resumed_pages = (
            getattr(converter, "resumed_from_pages", 0) if checkpoint_store else 0
        ) or None

        if stop_event and stop_event.is_set():
            raise InterruptedError("Conversion cancelled before saving result")

        # Persist the final Markdown BEFORE deleting the checkpoint so a
        # failure between the write and the cleanup leaves the cache intact
        # for a retry — never the other way around.
        atomic_write_text(md_path, md_content)

        # Clean up the checkpoint only when the conversion is fully clean
        # (no failed pages).  A partial conversion keeps its checkpoint so
        # "retry failed pages" — which re-submits the same convert request
        # — can resume the cached pages and re-attempt the failures.
        if checkpoint_store is not None and not failed_pages:
            checkpoint_store.discard()

        elapsed_ms = int((time.monotonic() - t0) * 1000)
        logger.info(
            "Conversion complete: '%s' → '%s' in %d ms (failed_pages=%s, resumed_pages=%s)",
            filename,
            md_filename,
            elapsed_ms,
            failed_pages,
            resumed_pages,
            extra={"operation": "convert", "file_name": filename, "duration_ms": elapsed_ms},
        )
        return ConvertResponse(
            success=True,
            md_filename=md_filename,
            message=f"Converted '{filename}' to Markdown using {converter_type.value}",
            md_content=md_content,
            failed_pages=failed_pages,
            resumed_pages=resumed_pages,
        )

    def preview_conversion(
        self,
        filename: str,
        converter_type: ConverterType = ConverterType.pymupdf,
        start_page: int = 1,
        end_page: int = 1,
        vlm_settings: VLMSettings | None = None,
        cloud_settings: CloudSettings | None = None,
        stop_event: threading.Event | None = None,
    ) -> ConvertPreviewResponse:
        """Convert a temporary page-range PDF and return Markdown without persisting it."""
        filename = safe_filename(filename, "PDF filename")
        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        settings = get_settings()
        selected_pages = end_page - start_page + 1
        if selected_pages <= 0:
            raise HTTPException(status_code=422, detail="start_page must be less than or equal to end_page.")
        if settings.CONVERSION_PREVIEW_MAX_PAGES > 0 and selected_pages > settings.CONVERSION_PREVIEW_MAX_PAGES:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Preview range contains {selected_pages} pages; maximum is "
                    f"{settings.CONVERSION_PREVIEW_MAX_PAGES}."
                ),
            )

        if stop_event and stop_event.is_set():
            raise InterruptedError("Preview cancelled before slicing PDF")

        temp_pdf, page_count = _slice_pdf_pages(pdf_path, start_page, end_page)
        try:
            _is_io_bound = converter_type in (ConverterType.vlm, ConverterType.cloud)
            converter = _build_converter(
                converter_type,
                vlm_settings,
                cloud_settings,
                stop_event=stop_event if _is_io_bound else None,
                checkpoint_store=None,
            )
            md_content = converter.convert(temp_pdf, total_pages=selected_pages)
            if stop_event and stop_event.is_set():
                raise InterruptedError("Preview cancelled before returning result")
        finally:
            temp_pdf.unlink(missing_ok=True)

        return ConvertPreviewResponse(
            filename=filename,
            converter=converter_type,
            start_page=start_page,
            end_page=end_page,
            page_count=page_count,
            md_content=md_content,
        )

    # ------------------------------------------------------------------
    # Convert MD → PDF
    # ------------------------------------------------------------------

    def convert_md_to_pdf(
        self,
        document_name: str,
        md_filename: str,
    ) -> MdToPdfResponse:
        md_path, pdf_path = self.prepare_md_to_pdf(document_name, md_filename)
        temp_path = create_pdf_temp_path(pdf_path)
        try:
            success = render_markdown_pdf_in_process(str(md_path), str(temp_path))
            return self.finish_md_to_pdf(md_filename, pdf_path, temp_path, success)
        finally:
            temp_path.unlink(missing_ok=True)

    def prepare_md_to_pdf(
        self,
        document_name: str,
        md_filename: str,
    ) -> tuple[Path, Path]:
        """Validate an MD→PDF request and return source/final paths."""
        md_filename = safe_filename(md_filename, "Markdown filename")
        document_name = safe_filename(document_name, "document name")
        try:
            owner_stem = document_stem_for_markdown(document_name, md_filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not document_name.lower().endswith(".md"):
            raise HTTPException(
                status_code=409,
                detail="MD to PDF conversion is only available for standalone Markdown documents.",
            )
        md_path = self._mds_dir / md_filename
        if not md_path.exists():
            raise HTTPException(status_code=404, detail=f"MD '{md_filename}' not found")

        pdf_path = self._pdfs_dir / f"{owner_stem}.pdf"
        if pdf_path.exists():
            raise HTTPException(
                status_code=409,
                detail=f"PDF '{pdf_path.name}' already exists; refusing to overwrite it.",
            )
        return md_path, pdf_path

    @staticmethod
    def finish_md_to_pdf(
        md_filename: str,
        pdf_path: Path,
        temp_path: Path,
        success: bool,
    ) -> MdToPdfResponse:
        """Publish a completed temporary PDF and build its API response."""
        if not success:
            raise HTTPException(status_code=500, detail="MD to PDF conversion failed")
        publish_pdf_without_overwrite(temp_path, pdf_path)
        return MdToPdfResponse(
            success=True,
            pdf_filename=pdf_path.name,
            message=f"Converted '{md_filename}' to PDF",
        )

    def delete_markdown_variant(
        self,
        document_name: str,
        md_filename: str,
    ) -> DeleteResponse:
        """Delete one Markdown artifact under an explicitly named owner."""
        document_name = safe_filename(document_name, "document name")
        md_filename = safe_filename(md_filename, "Markdown filename")
        try:
            document_stem_for_markdown(document_name, md_filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        md_path = self._mds_dir / md_filename
        if not md_path.exists():
            raise HTTPException(status_code=404, detail=f"MD '{md_filename}' not found")
        md_path.unlink()
        deleted = [str(md_path)]
        deleted.extend(
            str(path) for path in delete_chunks_for_markdown(
                self._chunks_dir,
                md_filename,
                document_name=document_name,
            )
        )
        self._discard_markdown_variant_caches(
            md_filename,
            document_name=document_name,
        )
        return DeleteResponse(
            success=True,
            deleted=deleted,
            deleted_documents=[md_filename],
            message=f"Deleted '{md_filename}' and {len(deleted) - 1} associated file(s)",
        )

    def delete_document(self, filename: str) -> DeleteResponse:
        filename = safe_filename(filename, "document name")
        ext = Path(filename).suffix.lower()
        deleted: list[str] = []
        stem = _stem(filename)

        if ext == ".md":
            return self.delete_markdown_variant(filename, filename)

        pdf_path = self._pdfs_dir / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail=f"PDF '{filename}' not found")

        # Remove visible derivatives first and the source PDF last. If cleanup
        # fails, the document remains addressable instead of leaving converter
        # Markdown behind as a misleading standalone upload.
        for md_file in _md_files_for_stem(self._mds_dir, stem):
            try:
                md_file.unlink()
                deleted.append(str(md_file))
            except OSError as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not delete Markdown derivative '{md_file.name}': {exc}",
                ) from exc

        chunks_path = self._chunks_dir / stem
        if chunks_path.exists():
            try:
                shutil.rmtree(chunks_path)
                deleted.append(str(chunks_path))
            except OSError as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Could not delete saved chunks for '{filename}': {exc}",
                ) from exc

        # Drop any checkpoint directories belonging to this stem.  They would
        # otherwise become orphans referring to a PDF that no longer exists
        # and would silently feed stale page content into the next document
        # uploaded under the same name.  Both VLM and enrichment checkpoint
        # dirs live under ``mds/.checkpoints/`` and must be cleaned together.
        # Document summaries (``mds/{stem}.summary.json`` plus legacy
        # per-variant records) follow the same lifecycle and are cleaned here
        # as well.
        self._discard_derived_caches(stem)

        try:
            pdf_path.unlink()
            deleted.append(str(pdf_path))
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Could not delete PDF '{filename}': {exc}",
            ) from exc

        associated = len(deleted) - 1
        return DeleteResponse(
            success=True,
            deleted=deleted,
            deleted_documents=[filename],
            message=f"Deleted '{filename}' and {associated} associated file(s)",
        )

    def delete_documents(self, filenames: list[str]) -> DeleteResponse:
        all_deleted: list[str] = []
        deleted_documents: list[str] = []
        errors: dict[str, str] = {}

        for filename in filenames:
            try:
                result = self.delete_document(filename)
                all_deleted.extend(result.deleted)
                deleted_documents.append(filename)
            except HTTPException as exc:
                errors[filename] = str(exc.detail)
            except OSError as exc:
                errors[filename] = str(exc)

        if errors and not all_deleted:
            raise HTTPException(
                status_code=404,
                detail="; ".join(f"{name}: {message}" for name, message in errors.items()),
            )

        deleted_count = len(filenames) - len(errors)
        message = f"Deleted {deleted_count} document(s)"
        if errors:
            message += f"; {len(errors)} failed: {', '.join(errors)}"

        return DeleteResponse(
            success=len(errors) == 0,
            deleted=all_deleted,
            deleted_documents=deleted_documents,
            failed=errors,
            message=message,
        )
