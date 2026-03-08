import shutil
from pathlib import Path
from typing import List

from fastapi import HTTPException, UploadFile

from backend.models.schemas import (
    DocumentInfo, UploadResponse, ConvertResponse,
    DeleteResponse, MultiUploadResponse, UploadFileResult,
)
from backend.utils.pdf_converter import pdf_to_markdown

PDFS_DIR = Path("docs/pdfs")
MDS_DIR = Path("docs/mds")
CHUNKS_DIR = Path("chunks")


class DocumentService:

    def list_documents(self) -> List[str]:
        """Return sorted list of all PDF filenames."""
        if not PDFS_DIR.exists():
            return []
        return sorted(f.name for f in PDFS_DIR.glob("*.pdf"))

    def get_document(self, filename: str) -> DocumentInfo:
        """Return metadata and markdown content for a PDF."""
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="PDF not found")

        md_filename = filename.replace(".pdf", ".md")
        md_path = MDS_DIR / md_filename
        md_content = md_path.read_text(encoding="utf-8") if md_path.exists() else ""

        return DocumentInfo(
            pdf_filename=filename,
            md_filename=md_filename,
            md_content=md_content,
            has_markdown=md_path.exists(),
        )

    def get_pdf_path(self, filename: str) -> Path:
        """Resolve and validate path to a PDF file."""
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="PDF not found")
        return pdf_path

    def upload_file(self, file: UploadFile) -> UploadResponse:
        """
        Persist an uploaded file (PDF or Markdown) to the appropriate directory.
        - .pdf  → docs/pdfs/
        - .md   → docs/mds/
        """
        name = file.filename or ""

        if name.endswith(".pdf"):
            dest_dir = PDFS_DIR
        elif name.endswith(".md"):
            dest_dir = MDS_DIR
        else:
            raise HTTPException(
                status_code=400,
                detail="Only .pdf and .md files are allowed",
            )

        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / name

        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        return UploadResponse(
            success=True,
            filename=name,
            message=f"File '{name}' uploaded successfully",
        )

    def upload_multiple_files(self, files: List[UploadFile]) -> MultiUploadResponse:
        """
        Upload multiple files, collecting per-file results.
        Never raises — failures are reported in the results list.
        """
        results: List[UploadFileResult] = []

        for file in files:
            name = file.filename or ""
            try:
                if name.endswith(".pdf"):
                    dest_dir = PDFS_DIR
                elif name.endswith(".md"):
                    dest_dir = MDS_DIR
                else:
                    results.append(UploadFileResult(
                        filename=name,
                        success=False,
                        message="Only .pdf and .md files are allowed",
                    ))
                    continue

                dest_dir.mkdir(parents=True, exist_ok=True)
                dest_path = dest_dir / name

                with open(dest_path, "wb") as buffer:
                    shutil.copyfileobj(file.file, buffer)

                results.append(UploadFileResult(
                    filename=name,
                    success=True,
                    message=f"Uploaded successfully",
                ))

            except Exception as e:
                results.append(UploadFileResult(
                    filename=name,
                    success=False,
                    message=str(e),
                ))

        uploaded = sum(1 for r in results if r.success)
        failed = len(results) - uploaded

        return MultiUploadResponse(
            uploaded=uploaded,
            failed=failed,
            results=results,
        )

    def convert_to_markdown(self, filename: str) -> ConvertResponse:
        """Convert a PDF to Markdown and persist the result."""
        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="PDF not found")

        md_content = pdf_to_markdown(pdf_path)

        MDS_DIR.mkdir(parents=True, exist_ok=True)
        md_filename = filename.replace(".pdf", ".md")
        (MDS_DIR / md_filename).write_text(md_content, encoding="utf-8")

        return ConvertResponse(
            success=True,
            md_filename=md_filename,
            message="PDF converted to Markdown successfully",
            md_content=md_content,
        )

    def delete_document(self, filename: str) -> DeleteResponse:
        """
        Delete a document and all its associated files:
        - docs/pdfs/<filename>
        - docs/mds/<stem>.md  (if exists)
        - chunks/<stem>/      (if exists)
        """
        stem = Path(filename).stem
        deleted: List[str] = []

        pdf_path = PDFS_DIR / filename
        if not pdf_path.exists():
            raise HTTPException(status_code=404, detail="PDF not found")

        pdf_path.unlink()
        deleted.append(str(pdf_path))

        md_path = MDS_DIR / f"{stem}.md"
        if md_path.exists():
            md_path.unlink()
            deleted.append(str(md_path))

        chunks_dir = CHUNKS_DIR / stem
        if chunks_dir.exists():
            shutil.rmtree(chunks_dir)
            deleted.append(str(chunks_dir))

        return DeleteResponse(
            success=True,
            deleted=deleted,
            message=f"Deleted '{filename}' and {len(deleted) - 1} associated file(s)",
        )

    def delete_multiple_documents(self, filenames: List[str]) -> DeleteResponse:
        """
        Delete multiple documents. Collects all deletions and errors.
        Raises 404 only if every file is missing.
        """
        all_deleted: List[str] = []
        errors: List[str] = []

        for filename in filenames:
            try:
                result = self.delete_document(filename)
                all_deleted.extend(result.deleted)
            except HTTPException as e:
                errors.append(f"{filename}: {e.detail}")

        if errors and not all_deleted:
            raise HTTPException(status_code=404, detail="; ".join(errors))

        msg = f"Deleted {len(filenames) - len(errors)} document(s)"
        if errors:
            msg += f" ({len(errors)} not found: {', '.join(errors)})"

        return DeleteResponse(
            success=len(errors) == 0,
            deleted=all_deleted,
            message=msg,
        )