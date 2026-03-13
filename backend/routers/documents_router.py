"""
Router for document management endpoints.

Prefix: /api
"""

import asyncio
from typing import List

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import FileResponse, Response

from backend.models.schemas import (
    ConversionProgressResponse,
    ConvertRequest,
    ConvertResponse,
    DeleteResponse,
    DocumentInfo,
    MdToPdfResponse,
    MultiUploadResponse,
)
from backend.services.document_service import DocumentService, progress_store

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


@router.post("/upload", response_model=MultiUploadResponse)
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload one or more PDF / Markdown files in a single request.

    - **.pdf** files are saved to ``docs/pdfs/``
    - **.md**  files are saved to ``docs/mds/``

    Returns a summary with per-file success / failure details.
    Individual failures do not abort the batch.
    """
    return _svc.upload_multiple_files(files)


@router.post("/convert/{filename}", response_model=ConvertResponse)
async def convert_pdf_to_markdown(
    http_request: Request,
    filename: str,
    request: ConvertRequest = ConvertRequest(),
):
    """Convert a stored PDF to Markdown using the specified converter engine.

    Pass an optional ``vlm`` object in the body to override the VLM defaults
    (model, base_url, api_key). The ``vlm`` field is ignored for non-VLM converters.
    Runs in a thread pool so the event loop stays free for other requests.
    """
    task = asyncio.create_task(
        asyncio.to_thread(
            _svc.convert_to_markdown,
            filename,
            converter_type=request.converter,
            vlm_settings=request.vlm,
        )
    )
    try:
        while not task.done():
            if await http_request.is_disconnected():
                task.cancel()
                return Response(status_code=499)
            await asyncio.sleep(0.5)
        return task.result()
    except asyncio.CancelledError:
        return Response(status_code=499)


@router.get("/convert-progress/{filename}", response_model=ConversionProgressResponse)
async def get_conversion_progress(filename: str):
    """Return the current conversion progress for *filename*.

    Intended to be polled by the frontend at ~500 ms intervals while a
    conversion is in progress.  Returns ``active: false`` when no conversion
    is running for that file.

    For VLM conversions ``current`` and ``total`` track page numbers (1-based);
    for other converters they remain 0 (indeterminate progress).
    """
    return progress_store.get(filename)


@router.post("/md-to-pdf/{filename}", response_model=MdToPdfResponse)
async def convert_md_to_pdf(
    http_request: Request,
    filename: str,
):
    """Convert a stored Markdown file to PDF using weasyprint.

    Runs in a thread pool so the event loop stays free for other requests.
    """
    task = asyncio.create_task(
        asyncio.to_thread(_svc.convert_md_to_pdf, filename)
    )
    try:
        while not task.done():
            if await http_request.is_disconnected():
                task.cancel()
                return Response(status_code=499)
            await asyncio.sleep(0.5)
        return task.result()
    except asyncio.CancelledError:
        return Response(status_code=499)


@router.delete("/documents", response_model=DeleteResponse)
async def delete_documents(filenames: List[str]):
    """Delete one or more documents and all their derived files.

    Accepts a JSON array of filenames in the request body.
    A single-element array deletes exactly one document.
    Partial success is allowed — the response reports which files were not found.
    """
    return _svc.delete_multiple_documents(filenames)
