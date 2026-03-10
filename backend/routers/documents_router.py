"""
Router for document management endpoints.

Prefix: /api
"""

from typing import List

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import FileResponse

from backend.models.schemas import (
    ConvertRequest,
    ConvertResponse,
    DeleteResponse,
    DocumentInfo,
    MultiUploadResponse,
    UploadResponse,
)
from backend.services.document_service import DocumentService

router = APIRouter(prefix="/api", tags=["documents"])
_svc = DocumentService()


@router.get("/documents", response_model=List[str])
async def list_documents():
    """Return a sorted list of all available PDF filenames."""
    return _svc.list_documents()


@router.get("/document/{filename}", response_model=DocumentInfo)
async def get_document(filename: str):
    """Return metadata and existing Markdown content for a PDF."""
    return _svc.get_document(filename)


@router.get("/pdf/{filename}")
async def serve_pdf(filename: str):
    """Serve a PDF file for inline viewing or download."""
    pdf_path = _svc.get_pdf_path(filename)
    return FileResponse(pdf_path, media_type="application/pdf", filename=filename)


@router.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)):
    """Upload a single PDF or Markdown file.

    - **.pdf** files are saved to ``docs/pdfs/``
    - **.md** files are saved to ``docs/mds/``
    """
    return _svc.upload_file(file)


@router.post("/upload/multiple", response_model=MultiUploadResponse)
async def upload_multiple_files(files: List[UploadFile] = File(...)):
    """Upload multiple PDF or Markdown files in one request.

    Returns a summary with per-file success / failure details.
    Individual failures do not abort the batch.
    """
    return _svc.upload_multiple_files(files)


@router.post("/convert/{filename}", response_model=ConvertResponse)
async def convert_pdf_to_markdown(
    filename: str,
    request: ConvertRequest = ConvertRequest(),
):
    """Convert a stored PDF to Markdown using the specified converter engine.

    Pass an optional ``vlm`` object in the body to override the VLM defaults
    (model, base_url, api_key). The ``vlm`` field is ignored for non-VLM converters.
    """
    return _svc.convert_to_markdown(
        filename,
        converter_type=request.converter,
        vlm_settings=request.vlm,
    )


@router.delete("/document/{filename}", response_model=DeleteResponse)
async def delete_document(filename: str):
    """Delete a PDF and all its derived files (Markdown, saved chunks)."""
    return _svc.delete_document(filename)


@router.delete("/documents", response_model=DeleteResponse)
async def delete_multiple_documents(filenames: List[str]):
    """Delete multiple documents and all their derived files.

    Accepts a JSON array of filenames in the request body.
    Partial success is allowed — the response reports which files were not found.
    """
    return _svc.delete_multiple_documents(filenames)