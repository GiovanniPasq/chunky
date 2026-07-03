from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import unittest

from fastapi import HTTPException

from backend.models.schemas import SaveChunksRequest
from backend.services.chunk_storage_service import ChunkStorageService, delete_chunks_for_markdown
from backend.utils.naming import params_used_by


def _source_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


class ChunkStorageServiceTests(unittest.TestCase):
    def test_chonkie_table_and_neural_ignore_size_parameters(self) -> None:
        self.assertEqual(params_used_by("chonkie", "table", False), (False, False))
        self.assertEqual(params_used_by("chonkie", "neural", False), (False, False))

    def test_saved_chunks_encode_converted_markdown_source(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = ChunkStorageService()
            service._chunks_dir = root / "chunks"
            service._mds_dir = root / "mds"
            service._mds_dir.mkdir()
            (service._mds_dir / "report_vlm.md").write_text("source markdown", encoding="utf-8")

            result = service.save_chunks(
                SaveChunksRequest(
                    filename="report.pdf",
                    md_filename="report_vlm.md",
                    source_hash=_source_hash("source markdown"),
                    chunker_library="langchain",
                    chunker_type="token",
                    chunk_size=512,
                    chunk_overlap=51,
                    chunks=[{"index": 0, "content": "hello"}],
                )
            )

            self.assertIn("report_vlm_langchain-token_512_51.json", result.path)

            versions = service.list_versions("report.pdf")
            self.assertEqual(len(versions), 1)
            self.assertEqual(versions[0].md_source, "vlm")
            self.assertEqual(versions[0].md_filename, "report_vlm.md")
            self.assertFalse(versions[0].is_stale)
            self.assertIsNotNone(versions[0].source_hash)

            (service._mds_dir / "report_vlm.md").write_text("changed", encoding="utf-8")
            self.assertTrue(service.list_versions("report.pdf")[0].is_stale)

    def test_saved_chunks_encode_uploaded_markdown_source(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = ChunkStorageService()
            service._chunks_dir = root / "chunks"
            service._mds_dir = root / "mds"
            service._mds_dir.mkdir()
            (service._mds_dir / "notes.md").write_text("source markdown", encoding="utf-8")

            result = service.save_chunks(
                SaveChunksRequest(
                    filename="notes.md",
                    md_filename="notes.md",
                    source_hash=_source_hash("source markdown"),
                    chunker_library="langchain",
                    chunker_type="token",
                    chunk_size=512,
                    chunk_overlap=51,
                    chunks=[{"index": 0, "content": "hello"}],
                )
            )

            self.assertIn("notes_uploaded_langchain-token_512_51.json", result.path)

            versions = service.list_versions("notes.md")
            self.assertEqual(len(versions), 1)
            self.assertEqual(versions[0].md_source, "uploaded")
            self.assertEqual(versions[0].md_filename, "notes.md")

    def test_delete_chunks_for_converted_markdown_preserves_sibling_sources(self) -> None:
        with TemporaryDirectory() as tmp:
            chunks_dir = Path(tmp)
            service = ChunkStorageService()
            service._chunks_dir = chunks_dir
            service._mds_dir = chunks_dir / "mds"
            service._mds_dir.mkdir()

            for md_filename in ("report_vlm.md", "report_docling.md"):
                (service._mds_dir / md_filename).write_text(md_filename, encoding="utf-8")
                service.save_chunks(
                    SaveChunksRequest(
                        filename="report.pdf",
                        md_filename=md_filename,
                        source_hash=_source_hash(md_filename),
                        chunker_library="langchain",
                        chunker_type="token",
                        chunk_size=512,
                        chunk_overlap=51,
                        chunks=[{"index": 0, "content": md_filename}],
                    )
                )

            deleted = delete_chunks_for_markdown(chunks_dir, "report_vlm.md")

            deleted_names = {path.name for path in deleted}
            self.assertIn("report_vlm_langchain-token_512_51.json", deleted_names)
            versions = service.list_versions("report.pdf")
            self.assertEqual(len(versions), 1)
            self.assertEqual(versions[0].md_source, "docling")
            self.assertEqual(versions[0].md_filename, "report_docling.md")

    def test_delete_chunks_for_uploaded_markdown_preserves_converted_sources(self) -> None:
        with TemporaryDirectory() as tmp:
            chunks_dir = Path(tmp)
            service = ChunkStorageService()
            service._chunks_dir = chunks_dir
            service._mds_dir = chunks_dir / "mds"
            service._mds_dir.mkdir()

            for md_filename in ("report.md", "report_vlm.md"):
                (service._mds_dir / md_filename).write_text(md_filename, encoding="utf-8")
                service.save_chunks(
                    SaveChunksRequest(
                        filename="report.pdf",
                        md_filename=md_filename,
                        source_hash=_source_hash(md_filename),
                        chunker_library="langchain",
                        chunker_type="token",
                        chunk_size=512,
                        chunk_overlap=51,
                        chunks=[{"index": 0, "content": md_filename}],
                    )
                )

            deleted = delete_chunks_for_markdown(chunks_dir, "report.md")

            deleted_names = {path.name for path in deleted}
            self.assertIn("report_uploaded_langchain-token_512_51.json", deleted_names)
            versions = service.list_versions("report.pdf")
            self.assertEqual(len(versions), 1)
            self.assertEqual(versions[0].md_source, "vlm")
            self.assertEqual(versions[0].md_filename, "report_vlm.md")

    def test_stale_chunks_cannot_be_resaved_as_fresh(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = ChunkStorageService()
            service._chunks_dir = root / "chunks"
            service._mds_dir = root / "mds"
            service._mds_dir.mkdir()
            md_path = service._mds_dir / "report_vlm.md"
            md_path.write_text("old markdown", encoding="utf-8")

            request = SaveChunksRequest(
                filename="report.pdf",
                md_filename="report_vlm.md",
                source_hash=_source_hash("old markdown"),
                chunker_library="langchain",
                chunker_type="token",
                chunk_size=512,
                chunk_overlap=51,
                chunks=[{"index": 0, "content": "old chunk"}],
            )
            service.save_chunks(request)
            md_path.write_text("new markdown", encoding="utf-8")

            with self.assertRaises(Exception) as raised:
                service.save_chunks(request)

            self.assertEqual(getattr(raised.exception, "status_code", None), 409)

    def test_chunks_cannot_reference_another_documents_markdown(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = ChunkStorageService()
            service._chunks_dir = root / "chunks"
            service._mds_dir = root / "mds"
            service._mds_dir.mkdir()
            (service._mds_dir / "other.md").write_text("other source", encoding="utf-8")

            with self.assertRaises(HTTPException) as raised:
                service.save_chunks(
                    SaveChunksRequest(
                        filename="report.pdf",
                        md_filename="other.md",
                        source_hash=_source_hash("other source"),
                        chunker_library="langchain",
                        chunker_type="token",
                        chunk_size=512,
                        chunk_overlap=51,
                        chunks=[{"index": 0, "content": "wrong owner"}],
                    )
                )

            self.assertEqual(raised.exception.status_code, 400)
            self.assertFalse((service._chunks_dir / "report").exists())


if __name__ == "__main__":
    unittest.main()
