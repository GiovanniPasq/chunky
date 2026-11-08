"""Bulk downloads and exports to the configured backend filesystem."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from backend.models.exports import ExportRequest
from backend.services.export_service import ExportService

router = APIRouter(prefix='/api/export', tags=['export'])


@router.get('/config')
def export_config():
    return {'directory': str(ExportService().exports)}


@router.post('')
def export_documents(request: ExportRequest):
    try:
        result, manifest = ExportService().export(request)
    except OSError as error:
        raise HTTPException(409, 'Export could not complete. Check folder permissions and retry after active processing finishes.') from error
    if request.destination == 'download':
        return FileResponse(result, media_type='application/zip', filename='chunky-export.zip', background=BackgroundTask(result.unlink, missing_ok=True))
    return {'directory': str(result), 'manifest': manifest}
