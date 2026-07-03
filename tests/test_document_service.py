from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from io import BytesIO
import threading
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend.models.schemas import ConverterType, VLMSettings
from backend.services import document_service as document_service_module
from backend.services.document_service import DocumentService


def _make_service(root: Path) -> DocumentService:
    pdfs_dir = root / "pdfs"
    mds_dir = root / "mds"
    chunks_dir = root / "chunks"
    pdfs_dir.mkdir()
    mds_dir.mkdir()
    chunks_dir.mkdir()

    service = DocumentService()
    service._pdfs_dir = pdfs_dir
    service._mds_dir = mds_dir
    service._chunks_dir = chunks_dir
    return service


class _FakeVLMConverter:
    failed_pages: list[int] = []
    resumed_from_pages = 0

    def __init__(self, content: str = "fresh markdown") -> None:
        self.content = content

    def convert(self, _pdf_path: Path, total_pages: int | None = None) -> str:
        return self.content


class DocumentServiceConversionTests(unittest.TestCase):
    @staticmethod
    def _pdf_bytes(page_count: int = 1) -> bytes:
        import fitz

        pdf = fitz.open()
        for _ in range(page_count):
            pdf.new_page()
        data = pdf.tobytes()
        pdf.close()
        return data

    def test_upload_normalises_uppercase_extension(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            upload = SimpleNamespace(
                filename="Report.MD",
                file=BytesIO(b"# Notes"),
            )

            stored_name = service.upload_file(upload)

            self.assertEqual(stored_name, "Report.md")
            self.assertTrue((service._mds_dir / "Report.md").exists())
            self.assertIn("Report.md", service.list_documents())

    def test_pdf_upload_rejects_converter_suffix_standalone_collision(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            (service._mds_dir / "notes_vlm.md").write_text(
                "# standalone notes",
                encoding="utf-8",
            )

            with self.assertRaises(HTTPException) as raised:
                service.upload_file(SimpleNamespace(
                    filename="notes.pdf",
                    file=BytesIO(self._pdf_bytes()),
                ))

            self.assertEqual(raised.exception.status_code, 409)
            self.assertFalse((service._pdfs_dir / "notes.pdf").exists())
            self.assertTrue((service._mds_dir / "notes_vlm.md").exists())

    def test_converter_suffix_markdown_upload_rejects_existing_pdf_collision(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            (service._pdfs_dir / "notes.pdf").write_bytes(self._pdf_bytes())

            with self.assertRaises(HTTPException) as raised:
                service.upload_file(SimpleNamespace(
                    filename="notes_vlm.md",
                    file=BytesIO(b"# standalone notes"),
                ))

            self.assertEqual(raised.exception.status_code, 409)
            self.assertFalse((service._mds_dir / "notes_vlm.md").exists())

    def test_existing_pdf_overwrite_allows_owned_converter_variant(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            (service._pdfs_dir / "notes.pdf").write_bytes(self._pdf_bytes())
            (service._mds_dir / "notes_vlm.md").write_text(
                "old conversion",
                encoding="utf-8",
            )
            chunks_path = service._chunks_dir / "notes"
            chunks_path.mkdir()
            (chunks_path / "notes_vlm_langchain-token_512_51.json").write_text(
                "{}",
                encoding="utf-8",
            )

            service.upload_file(SimpleNamespace(
                filename="notes.pdf",
                file=BytesIO(self._pdf_bytes()),
            ))

            self.assertTrue((service._pdfs_dir / "notes.pdf").exists())
            self.assertFalse((service._mds_dir / "notes_vlm.md").exists())
            self.assertFalse(chunks_path.exists())

    def test_pdf_overwrite_is_not_published_when_derivative_cleanup_fails(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            pdf_path = service._pdfs_dir / "report.pdf"
            md_path = service._mds_dir / "report_vlm.md"
            original_pdf = self._pdf_bytes()
            pdf_path.write_bytes(original_pdf)
            md_path.write_text("old conversion", encoding="utf-8")
            original_unlink = Path.unlink

            def fail_markdown(path: Path, *args, **kwargs):
                if path == md_path:
                    raise OSError("simulated failure")
                return original_unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", autospec=True, side_effect=fail_markdown):
                with self.assertRaises(HTTPException):
                    service.upload_file(SimpleNamespace(
                        filename="report.pdf",
                        file=BytesIO(self._pdf_bytes()),
                    ))

            self.assertEqual(pdf_path.read_bytes(), original_pdf)
            self.assertTrue(md_path.exists())
            self.assertEqual(list(service._pdfs_dir.glob("*.upload")), [])

    def test_rejected_pdf_overwrite_preserves_existing_file_and_artifacts(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            pdfs_dir = service._pdfs_dir
            mds_dir = service._mds_dir

            original_pdf = b"%PDF-1.4\nold pdf bytes\n"
            (pdfs_dir / "report.pdf").write_bytes(original_pdf)
            (mds_dir / "report_vlm.md").write_text("old markdown", encoding="utf-8")

            upload = SimpleNamespace(
                filename="report.pdf",
                file=BytesIO(b"not actually a pdf"),
            )

            with self.assertRaises(Exception):
                service.upload_file(upload)

            self.assertEqual((pdfs_dir / "report.pdf").read_bytes(), original_pdf)
            self.assertTrue((mds_dir / "report_vlm.md").exists())

    def test_oversized_pdf_overwrite_preserves_existing_file(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            pdfs_dir = service._pdfs_dir

            original_pdf = b"%PDF-1.4\nold pdf bytes\n"
            (pdfs_dir / "report.pdf").write_bytes(original_pdf)

            original_get_settings = document_service_module.get_settings
            document_service_module.get_settings = lambda: SimpleNamespace(
                MAX_FILE_SIZE_MB=1,
                UPLOAD_READ_CHUNK_BYTES=64 * 1024,
                PDF_MAGIC_PROBE_BYTES=512,
            )
            upload = SimpleNamespace(
                filename="report.pdf",
                file=BytesIO(b"%PDF-1.4\n" + (b"x" * (1024 * 1024 + 1))),
            )
            try:
                with self.assertRaises(Exception):
                    service.upload_file(upload)
            finally:
                document_service_module.get_settings = original_get_settings

            self.assertEqual((pdfs_dir / "report.pdf").read_bytes(), original_pdf)

    def test_vlm_markdown_with_failure_marker_is_reconverted_without_checkpoint(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            pdfs_dir = service._pdfs_dir
            mds_dir = service._mds_dir

            import fitz

            pdf = fitz.open()
            pdf.new_page()
            pdf.save(pdfs_dir / "report.pdf")
            pdf.close()
            (mds_dir / "report_vlm.md").write_text(
                "<!-- page-marker:1 -->\n<!-- page 1 failed: timeout -->",
                encoding="utf-8",
            )

            original_build_converter = document_service_module._build_converter
            calls = {"count": 0}

            def fake_build_converter(*_args, **_kwargs):
                calls["count"] += 1
                return _FakeVLMConverter()

            document_service_module._build_converter = fake_build_converter
            try:
                result = service.convert_to_markdown(
                    "report.pdf",
                    converter_type=ConverterType.vlm,
                    vlm_settings=VLMSettings(),
                )
            finally:
                document_service_module._build_converter = original_build_converter

            self.assertEqual(calls["count"], 1)
            self.assertEqual(result.md_content, "fresh markdown")
            self.assertEqual((mds_dir / "report_vlm.md").read_text(encoding="utf-8"), "fresh markdown")

    def test_preview_conversion_slices_pages_without_persisting_markdown(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            (service._pdfs_dir / "report.pdf").write_bytes(self._pdf_bytes(page_count=4))

            seen: dict[str, int | bool] = {}

            class _PreviewConverter:
                def convert(self, pdf_path: Path, total_pages: int | None = None) -> str:
                    import fitz

                    seen["exists_during_convert"] = pdf_path.exists()
                    seen["total_pages"] = total_pages or 0
                    with fitz.open(str(pdf_path)) as doc:
                        seen["sliced_pages"] = doc.page_count
                    return "preview markdown"

            original_build_converter = document_service_module._build_converter
            document_service_module._build_converter = lambda *_args, **_kwargs: _PreviewConverter()
            try:
                result = service.preview_conversion(
                    "report.pdf",
                    converter_type=ConverterType.pymupdf,
                    start_page=2,
                    end_page=3,
                )
            finally:
                document_service_module._build_converter = original_build_converter

            self.assertEqual(result.md_content, "preview markdown")
            self.assertEqual(result.page_count, 4)
            self.assertEqual(seen, {
                "exists_during_convert": True,
                "total_pages": 2,
                "sliced_pages": 2,
            })
            self.assertEqual(list(service._mds_dir.iterdir()), [])

    def test_preview_conversion_rejects_invalid_page_range(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            (service._pdfs_dir / "report.pdf").write_bytes(self._pdf_bytes(page_count=2))

            with self.assertRaises(HTTPException) as raised:
                service.preview_conversion(
                    "report.pdf",
                    converter_type=ConverterType.pymupdf,
                    start_page=2,
                    end_page=1,
                )

            self.assertEqual(raised.exception.status_code, 422)

    def test_document_metadata_distinguishes_vlm_failures_from_checkpoints(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            (service._pdfs_dir / "interrupted.pdf").write_bytes(self._pdf_bytes())
            (service._pdfs_dir / "failed.pdf").write_bytes(self._pdf_bytes())

            checkpoint = document_service_module.CheckpointStore("interrupted", service._mds_dir)
            checkpoint.save_page(0, "cached page")

            (service._mds_dir / "failed_vlm.md").write_text(
                "<!-- page-marker:1 -->\n<!-- page 1 failed: timeout -->",
                encoding="utf-8",
            )

            by_name = {
                item["filename"]: item
                for item in service.list_documents_metadata()
            }

            self.assertFalse(by_name["interrupted.pdf"]["has_failures"])
            self.assertTrue(by_name["interrupted.pdf"]["has_checkpoint"])
            self.assertTrue(by_name["failed.pdf"]["has_failures"])
            self.assertFalse(by_name["failed.pdf"]["has_checkpoint"])

    def test_force_reconverts_existing_markdown_variant(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            pdfs_dir = service._pdfs_dir
            mds_dir = service._mds_dir

            import fitz

            pdf = fitz.open()
            pdf.new_page()
            pdf.save(pdfs_dir / "report.pdf")
            pdf.close()
            (mds_dir / "report_pymupdf4llm.md").write_text(
                "stale markdown",
                encoding="utf-8",
            )

            original_build_converter = document_service_module._build_converter
            calls = {"count": 0}

            def fake_build_converter(*_args, **_kwargs):
                calls["count"] += 1
                return _FakeVLMConverter("fresh markdown")

            document_service_module._build_converter = fake_build_converter
            try:
                result = service.convert_to_markdown(
                    "report.pdf",
                    converter_type=ConverterType.pymupdf,
                    force=True,
                )
            finally:
                document_service_module._build_converter = original_build_converter

            self.assertEqual(calls["count"], 1)
            self.assertEqual(result.md_content, "fresh markdown")
            self.assertEqual(
                (mds_dir / "report_pymupdf4llm.md").read_text(encoding="utf-8"),
                "fresh markdown",
            )

    def test_cancelled_io_conversion_does_not_publish_returned_content(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            (service._pdfs_dir / "report.pdf").write_bytes(self._pdf_bytes())
            stop = threading.Event()

            class _StopsBeforeReturn:
                failed_pages: list[int] = []
                resumed_from_pages = 0

                def convert(self, _pdf_path: Path, total_pages: int | None = None) -> str:
                    stop.set()
                    return "must not be saved"

            original_build_converter = document_service_module._build_converter
            document_service_module._build_converter = lambda *_args, **_kwargs: _StopsBeforeReturn()
            try:
                with self.assertRaises(InterruptedError):
                    service.convert_to_markdown(
                        "report.pdf",
                        converter_type=ConverterType.cloud,
                        stop_event=stop,
                        force=True,
                    )
            finally:
                document_service_module._build_converter = original_build_converter

            self.assertFalse((service._mds_dir / "report_cloud.md").exists())

    def test_cancelled_vlm_retry_patches_checkpointed_failed_pages(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))

            import fitz

            pdf = fitz.open()
            for _ in range(3):
                pdf.new_page()
            pdf.save(service._pdfs_dir / "report.pdf")
            pdf.close()

            md_path = service._mds_dir / "report_vlm.md"
            md_path.write_text(
                "<!-- page-marker:1 -->\n"
                "<!-- page 1 failed: timeout -->\n\n"
                "---\n\n"
                "<!-- page-marker:2 -->\n"
                "<!-- page 2 failed: rate limit -->\n\n"
                "---\n\n"
                "<!-- page-marker:3 -->\n"
                "previous success",
                encoding="utf-8",
            )

            class _InterruptedRetry:
                failed_pages: list[int] = []
                resumed_from_pages = 0

                def __init__(self, checkpoint_store) -> None:
                    self._checkpoint_store = checkpoint_store

                def convert(self, _pdf_path: Path, total_pages: int | None = None) -> str:
                    self._checkpoint_store.save_page(0, "retried page 1")
                    raise InterruptedError("cancelled")

            original_build_converter = document_service_module._build_converter

            def fake_build_converter(*_args, **kwargs):
                return _InterruptedRetry(kwargs["checkpoint_store"])

            document_service_module._build_converter = fake_build_converter
            try:
                with self.assertRaises(InterruptedError):
                    service.convert_to_markdown(
                        "report.pdf",
                        converter_type=ConverterType.vlm,
                        vlm_settings=VLMSettings(),
                        stop_event=threading.Event(),
                        force=True,
                    )
            finally:
                document_service_module._build_converter = original_build_converter

            content = md_path.read_text(encoding="utf-8")
            self.assertIn("retried page 1", content)
            self.assertNotIn("page 1 failed", content)
            self.assertIn("page 2 failed", content)
            self.assertIn("previous success", content)

    def test_deleting_vlm_markdown_removes_vlm_checkpoint_only(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            mds_dir = service._mds_dir

            (mds_dir / "report_vlm.md").write_text("vlm markdown", encoding="utf-8")
            checkpoint_dir = mds_dir / ".checkpoints" / "report_vlm"
            checkpoint_dir.mkdir(parents=True)
            (checkpoint_dir / "page_0001.md").write_text("cached page", encoding="utf-8")

            enrich_dir = mds_dir / ".checkpoints" / "report_vlm_enrich"
            enrich_dir.mkdir()
            (enrich_dir / "piece_0001.json").write_text("{}", encoding="utf-8")

            summary_path = mds_dir / "report.summary.json"
            summary_path.write_text("{}", encoding="utf-8")

            service.delete_markdown_variant("report.pdf", "report_vlm.md")

            self.assertFalse((mds_dir / "report_vlm.md").exists())
            self.assertFalse(checkpoint_dir.exists())
            self.assertFalse(enrich_dir.exists())
            self.assertTrue(summary_path.exists())

    def test_overwriting_markdown_removes_stale_variant_artifacts(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            mds_dir = service._mds_dir
            chunks_dir = service._chunks_dir

            (mds_dir / "report_vlm.md").write_text("old markdown", encoding="utf-8")
            chunk_dir = chunks_dir / "report"
            chunk_dir.mkdir()
            chunk_path = chunk_dir / "report_vlm_langchain-token_512_51.json"
            chunk_path.write_text("{}", encoding="utf-8")

            checkpoint_dir = mds_dir / ".checkpoints" / "report_vlm"
            checkpoint_dir.mkdir(parents=True)
            (checkpoint_dir / "page_0001.md").write_text("cached page", encoding="utf-8")

            enrich_dir = mds_dir / ".checkpoints" / "report_vlm_enrich"
            enrich_dir.mkdir()
            (enrich_dir / "piece_0001.json").write_text("{}", encoding="utf-8")

            summary_path = mds_dir / "report.summary.json"
            summary_path.write_text("{}", encoding="utf-8")

            service.save_markdown_content(
                "report.pdf",
                "report_vlm.md",
                "new markdown",
            )

            self.assertEqual((mds_dir / "report_vlm.md").read_text(encoding="utf-8"), "new markdown")
            self.assertFalse(chunk_path.exists())
            self.assertFalse(checkpoint_dir.exists())
            self.assertFalse(enrich_dir.exists())
            self.assertTrue(summary_path.exists())

    def test_standalone_converter_like_markdown_owns_its_artifacts(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            mds_dir = service._mds_dir
            chunks_dir = service._chunks_dir

            (mds_dir / "notes_vlm.md").write_text("standalone", encoding="utf-8")
            chunk_dir = chunks_dir / "notes_vlm"
            chunk_dir.mkdir()
            chunk_path = chunk_dir / "notes-vlm_uploaded_langchain-token_10_1.json"
            chunk_path.write_text("{}", encoding="utf-8")

            service.delete_markdown_variant("notes_vlm.md", "notes_vlm.md")

            self.assertFalse((mds_dir / "notes_vlm.md").exists())
            self.assertFalse(chunk_path.exists())

    def test_md_to_pdf_rejects_converted_variant_owner(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            (service._mds_dir / "report_vlm.md").write_text("variant", encoding="utf-8")

            with self.assertRaises(HTTPException) as raised:
                service.convert_md_to_pdf("report.pdf", "report_vlm.md")

            self.assertEqual(raised.exception.status_code, 409)

    def test_partial_delete_reports_only_successful_documents(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = _make_service(root)
            (service._pdfs_dir / "ok.pdf").write_bytes(b"%PDF")

            result = service.delete_documents(["ok.pdf", "missing.pdf"])

            self.assertFalse(result.success)
            self.assertEqual(result.deleted_documents, ["ok.pdf"])
            self.assertIn("missing.pdf", result.failed)

    def test_pdf_remains_when_derivative_deletion_fails(self) -> None:
        with TemporaryDirectory() as tmp:
            service = _make_service(Path(tmp))
            pdf_path = service._pdfs_dir / "report.pdf"
            md_path = service._mds_dir / "report_vlm.md"
            pdf_path.write_bytes(b"%PDF")
            md_path.write_text("derived", encoding="utf-8")
            original_unlink = Path.unlink

            def fail_markdown(path: Path, *args, **kwargs):
                if path == md_path:
                    raise OSError("simulated failure")
                return original_unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", autospec=True, side_effect=fail_markdown):
                with self.assertRaises(HTTPException):
                    service.delete_document("report.pdf")

            self.assertTrue(pdf_path.exists())
            self.assertTrue(md_path.exists())


if __name__ == "__main__":
    unittest.main()
