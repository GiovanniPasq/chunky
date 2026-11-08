import hashlib
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.models.exports import ExportRequest
from backend.routers.exports_router import router
from backend.services.export_service import ExportService


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        settings = SimpleNamespace(PDFS_DIR=str(root/'pdfs'), MDS_DIR=str(root/'mds'),
                                   CHUNKS_DIR=str(root/'chunks'), EXPORTS_DIR=str(root/'exports'))
        self.patch = patch('backend.services.export_service.get_settings', return_value=settings)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.service = ExportService()
        for directory in (self.service.pdfs, self.service.mds, self.service.chunks/'a'):
            directory.mkdir(parents=True)
        (self.service.pdfs/'a.pdf').write_bytes(b'%PDF-source')
        for index, source in enumerate(('pymupdf4llm', 'docling')):
            md = self.service.mds/f'a_{source}.md'
            md.write_text(f'Content from {source}')
            os.utime(md, (100+index, 100+index))
            saved = self.service.chunks/'a'/f'a_{source}_langchain-token_512_51.json'
            saved.write_text(json.dumps({'chunks': [], 'source_hash': hashlib.sha256(md.read_bytes()).hexdigest()}))
            os.utime(saved, (200-index, 200-index))
        (self.service.mds/'a_notes.md').write_text('Separate standalone document')
        (self.service.mds/'.checkpoint').write_text('Must not be exported')

    def test_latest_matches_chunks_to_latest_markdown_and_preserves_workspace(self):
        archive, _ = self.service.export(ExportRequest(filenames=['a.pdf']))
        self.addCleanup(archive.unlink, missing_ok=True)
        with ZipFile(archive) as bundle:
            self.assertEqual(set(bundle.namelist()), {
                'documents/a.pdf/markdown/a_docling.md',
                'documents/a.pdf/chunks/a_docling_langchain-token_512_51.json', 'manifest.json'})
        self.assertTrue((self.service.pdfs/'a.pdf').exists())
        self.assertTrue((self.service.mds/'a_pymupdf4llm.md').exists())

    def test_all_versions_and_pdf_and_duplicate_requests(self):
        archive, _ = self.service.export(ExportRequest(filenames=['a.pdf', 'a.pdf'], versions='all', include_pdfs=True))
        self.addCleanup(archive.unlink, missing_ok=True)
        with ZipFile(archive) as bundle:
            self.assertEqual(len(bundle.namelist()), 6)
            self.assertFalse(any('notes' in name or 'checkpoint' in name for name in bundle.namelist()))
            self.assertEqual(bundle.read('documents/a.pdf/source/a.pdf'), b'%PDF-source')

    def test_folder_exports_are_unique_and_report_stale_chunks(self):
        (self.service.mds/'a_docling.md').write_text('Edited source')
        request = ExportRequest(filenames=['a.pdf'], destination='folder', folder='datasets')
        first, manifest = self.service.export(request)
        second, _ = self.service.export(request)
        self.assertNotEqual(first, second)
        self.assertTrue((first/'manifest.json').exists())
        self.assertTrue(manifest['documents'][0]['warnings'])
        self.assertEqual(first.parent, self.service.exports/'datasets')

    def test_traversal_and_symlink_sources_and_destinations_are_rejected(self):
        for field, value in [('filenames', ['../a.pdf']), ('folder', '..')]:
            with self.subTest(field=field), self.assertRaises(HTTPException):
                self.service.export(ExportRequest(**{'filenames': ['a.pdf'], 'destination': 'folder', field: value}))
        self.service.exports.mkdir()
        outside_folder = Path(self.temp.name)/'outside-folder'
        outside_folder.mkdir()
        (self.service.exports/'escape').symlink_to(outside_folder, target_is_directory=True)
        with self.assertRaises(HTTPException):
            self.service.export(ExportRequest(filenames=['a.pdf'], destination='folder', folder='escape'))
        outside = Path(self.temp.name)/'outside.md'
        outside.write_text('Outside the workspace')
        md = self.service.mds/'a_docling.md'
        md.unlink(); md.symlink_to(outside)
        with self.assertRaises(HTTPException):
            self.service.collect(ExportRequest(filenames=['a.pdf']))

    def test_empty_exports_and_missing_documents_are_explicit_errors(self):
        with self.assertRaises(HTTPException) as error:
            self.service.collect(ExportRequest(filenames=['a_notes.md'], include_markdown=False))
        self.assertEqual(error.exception.status_code, 400)
        with self.assertRaises(HTTPException) as error:
            self.service.collect(ExportRequest(filenames=['missing.pdf']))
        self.assertEqual(error.exception.status_code, 404)

    def test_download_endpoint_returns_a_zip_and_removes_temporary_archive(self):
        app = FastAPI(); app.include_router(router)
        with TestClient(app) as client:
            archive, manifest = self.service.export(ExportRequest(filenames=['a.pdf']))
            self.addCleanup(archive.unlink, missing_ok=True)
            with patch('backend.routers.exports_router.ExportService.export', return_value=(archive, manifest)):
                response = client.post('/api/export', json={'filenames': ['a.pdf']})
            self.assertFalse(archive.exists())
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['content-type'], 'application/zip')
            with ZipFile(io.BytesIO(response.content)) as bundle:
                self.assertIn('manifest.json', bundle.namelist())
            folder = client.post('/api/export', json={'filenames': ['a.pdf'], 'destination': 'folder'})
            self.assertEqual(folder.status_code, 200)
            self.assertTrue(Path(folder.json()['directory']).is_dir())
            self.assertEqual(client.post('/api/export', json={'filenames': ['a.pdf'], 'include_markdown': False, 'include_chunks': False}).status_code, 422)


if __name__ == '__main__':
    unittest.main()
