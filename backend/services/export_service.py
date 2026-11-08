"""Export saved outputs without moving workspace files or including caches."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED

from fastapi import HTTPException

from backend.config import get_settings
from backend.models.exports import ExportRequest
from backend.services.chunk_storage_service import ChunkStorageService
from backend.services.document_files import md_files_for_stem
from backend.services.document_service import DocumentService
from backend.utils.path import safe_child_path


class ExportService:
    def __init__(self):
        settings = get_settings()
        self.pdfs = Path(settings.PDFS_DIR).resolve()
        self.mds = Path(settings.MDS_DIR).resolve()
        self.chunks = Path(settings.CHUNKS_DIR).resolve()
        self.exports = Path(settings.EXPORTS_DIR).resolve()

    @staticmethod
    def _file(base: Path, name: str) -> Path:
        candidate = safe_child_path(base, name, description='export filename')
        if not candidate.resolve().is_relative_to(base.resolve()):
            raise HTTPException(400, 'Export source escapes the workspace.')
        if not candidate.is_file():
            raise HTTPException(404, f"Saved file '{name}' is no longer available.")
        return candidate

    def collect(self, request: ExportRequest):
        documents = DocumentService()
        documents._pdfs_dir, documents._mds_dir = self.pdfs, self.mds
        available = set(documents.list_documents())
        storage = ChunkStorageService()
        storage._chunks_dir, storage._mds_dir = self.chunks, self.mds
        files: list[tuple[Path, str]] = []
        manifest = {'created_at': datetime.now(timezone.utc).isoformat(), 'versions': request.versions, 'documents': []}
        for name in dict.fromkeys(request.filenames):
            safe_child_path(self.pdfs, name, description='document name')
            if name not in available:
                raise HTTPException(404, f"Document '{name}' not found.")
            stem = Path(name).stem
            candidates = ([self._file(self.mds, name)] if name.endswith('.md') else
                          [self._file(self.mds, item.name) for item in md_files_for_stem(self.mds, stem)])
            candidates.sort(key=lambda item: (item.stat().st_mtime_ns, item.name), reverse=True)
            chosen = candidates if request.versions == 'all' else candidates[:1]
            versions = storage.list_versions(name)
            if request.versions == 'latest':
                versions = [version for version in versions if not chosen or version.md_filename in (None, chosen[0].name)][:1]
            entry = {'document': name, 'files': [], 'warnings': []}
            def add(source: Path, category: str):
                archive_name = f'documents/{name}/{category}/{source.name}'
                files.append((source, archive_name))
                entry['files'].append(archive_name)
            if request.include_pdfs and name.endswith('.pdf'):
                add(self._file(self.pdfs, name), 'source')
            if request.include_markdown:
                for item in chosen:
                    add(item, 'markdown')
            if request.include_chunks:
                for version in versions:
                    chunk_base = self.chunks / stem
                    if not chunk_base.resolve().is_relative_to(self.chunks):
                        raise HTTPException(400, 'Export source escapes the workspace.')
                    add(self._file(chunk_base, version.filename), 'chunks')
                    if version.is_stale:
                        entry['warnings'].append(f'{version.filename}: source changed or revision is unknown; regenerate before indexing.')
            if not entry['files']:
                entry['warnings'].append('No saved files matched the export options.')
            manifest['documents'].append(entry)
        if not files:
            raise HTTPException(400, 'No saved files match these export options.')
        return files, manifest

    def export(self, request: ExportRequest):
        files, manifest = self.collect(request)
        name = f"chunky-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{uuid4().hex[:8]}"
        if request.destination == 'download':
            handle, filename = tempfile.mkstemp(prefix=name, suffix='.zip')
            os.close(handle)
            archive = Path(filename)
            try:
                with ZipFile(archive, 'w', compression=ZIP_DEFLATED, strict_timestamps=False) as bundle:
                    for source, relative in files:
                        bundle.write(source, relative)
                    bundle.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            except BaseException:
                archive.unlink(missing_ok=True)
                raise
            return archive, manifest
        destination = safe_child_path(self.exports, request.folder, description='export folder') if request.folder else self.exports
        if not destination.resolve().is_relative_to(self.exports):
            raise HTTPException(400, 'Export folder escapes EXPORTS_DIR.')
        # Never copy exports into source directories, even under custom configuration.
        if any(destination.resolve().is_relative_to(source) for source in (self.pdfs, self.mds, self.chunks)):
            raise HTTPException(400, 'EXPORTS_DIR must be outside PDFS_DIR, MDS_DIR, and CHUNKS_DIR.')
        destination.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix='.export-', dir=destination))
        final = destination / name
        try:
            for source, relative in files:
                output = staging / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, output)
            (staging / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
            staging.rename(final)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return final, manifest
