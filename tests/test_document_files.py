from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from backend.services.document_files import (
    document_stem_for_markdown,
    find_markdown_for_document,
    md_files_for_stem,
    preferred_markdown_for_stem,
)


class DocumentFilesTests(unittest.TestCase):
    def test_explicit_owner_keeps_converter_like_upload_standalone(self) -> None:
        self.assertEqual(
            document_stem_for_markdown("notes_vlm.md", "notes_vlm.md"),
            "notes_vlm",
        )
        self.assertEqual(
            document_stem_for_markdown("report.pdf", "report_vlm.md"),
            "report",
        )

    def test_md_files_for_stem_excludes_prefix_siblings(self) -> None:
        with TemporaryDirectory() as tmp:
            mds_dir = Path(tmp)
            (mds_dir / "report.md").write_text("uploaded", encoding="utf-8")
            (mds_dir / "report_vlm.md").write_text("converted", encoding="utf-8")
            (mds_dir / "report_notes.md").write_text("sibling", encoding="utf-8")
            (mds_dir / "report2.md").write_text("other", encoding="utf-8")

            names = {path.name for path in md_files_for_stem(mds_dir, "report")}

            self.assertEqual(names, {"report.md", "report_vlm.md"})

    def test_preferred_markdown_for_stem_uses_stable_converted_variant(self) -> None:
        with TemporaryDirectory() as tmp:
            mds_dir = Path(tmp)
            (mds_dir / "report.md").write_text("uploaded", encoding="utf-8")
            (mds_dir / "report_vlm.md").write_text("vlm", encoding="utf-8")
            (mds_dir / "report_docling.md").write_text("docling", encoding="utf-8")

            preferred = preferred_markdown_for_stem(mds_dir, "report")

            self.assertIsNotNone(preferred)
            self.assertEqual(preferred.name, "report_docling.md")

    def test_find_markdown_for_document_honours_explicit_variant(self) -> None:
        with TemporaryDirectory() as tmp:
            mds_dir = Path(tmp)
            (mds_dir / "report_docling.md").write_text("docling", encoding="utf-8")
            (mds_dir / "report_vlm.md").write_text("vlm", encoding="utf-8")

            chosen = find_markdown_for_document(
                "report.pdf",
                mds_dir,
                md_filename="report_vlm.md",
            )

            self.assertIsNotNone(chosen)
            self.assertEqual(chosen.name, "report_vlm.md")


if __name__ == "__main__":
    unittest.main()
