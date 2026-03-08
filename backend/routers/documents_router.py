from pathlib import Path
from typing import List

from fastapi import APIRouter, File, UploadFile, HTTPException
from fastapi.responses import FileResponse

from backend.models.schemas import (
    DocumentInfo, UploadResponse, ConvertResponse,
    DeleteResponse, MultiUploadResponse,
)
from backend.services.document_service import DocumentService

router = APIRouter(prefix="/api", tags=["documents"])
_svc = DocumentService()


@router.get("/documents", response_model=List[str])
async def list_documents():
    """List all available PDF documents."""
    return _svc.list_documents()


@router.get("/document/{filename}", response_model=DocumentInfo)
async def get_document(filename: str):
    """Return metadata and Markdown content for a specific PDF."""
    return _svc.get_document(filename)


@router.get("/pdf/{filename}")
async def get_pdf(filename: str):
    """Serve a PDF file directly."""
    pdf_path = _svc.get_pdf_path(filename)
    return FileResponse(pdf_path, media_type="application/pdf", filename=filename)


@router.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a single PDF or Markdown file.
    - .pdf files are stored in docs/pdfs/
    - .md  files are stored in docs/mds/
    """
    return _svc.upload_file(file)


@router.post("/upload/multiple", response_model=MultiUploadResponse)
async def upload_multiple_files(files: List[UploadFile] = File(...)):
    """
    Upload multiple PDF or Markdown files in a single request.
    Returns a summary with per-file success/failure details.
    """
    return _svc.upload_multiple_files(files)


@router.post("/convert/{filename}", response_model=ConvertResponse)
async def convert_pdf_to_markdown(filename: str):
    """Convert an existing PDF to Markdown."""
    return _svc.convert_to_markdown(filename)


@router.delete("/document/{filename}", response_model=DeleteResponse)
async def delete_document(filename: str):
    """
    Delete a document and all its associated files:
    - docs/pdfs/<filename>.pdf
    - docs/mds/<stem>.md  (if exists)
    - chunks/<stem>/      (if exists)
    """
    return _svc.delete_document(filename)


@router.delete("/documents", response_model=DeleteResponse)
async def delete_multiple_documents(filenames: List[str]):
    """
    Delete multiple documents and all their associated files.
    Accepts a JSON array of filenames in the request body.
    """
    return _svc.delete_multiple_documents(filenames)