from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch

from backend.converters.liteparse import LiteParseConverter


class LiteParseConverterTests(unittest.TestCase):
    def test_requests_markdown_output(self) -> None:
        constructor_options = {}
        parsed_paths = []

        class FakeLiteParse:
            def __init__(self, **options) -> None:
                constructor_options.update(options)

            def parse(self, path: str):
                parsed_paths.append(path)
                return SimpleNamespace(text="# Markdown")

        fake_module = ModuleType("liteparse")
        fake_module.LiteParse = FakeLiteParse

        with TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "report.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")

            with patch.dict(sys.modules, {"liteparse": fake_module}):
                result = LiteParseConverter().convert(pdf_path)

        self.assertEqual(constructor_options, {"output_format": "markdown"})
        self.assertEqual(parsed_paths, [str(pdf_path)])
        self.assertEqual(result, "# Markdown")


if __name__ == "__main__":
    unittest.main()
