import unittest

from backend.utils.markdown.cleanup import clean_markdown


class MarkdownCleanupTests(unittest.TestCase):
    def test_fenced_code_is_preserved_byte_for_byte(self) -> None:
        source = (
            "Before\n\n"
            "```python\n"
            "1\n"
            "2025\n"
            "well-\n"
            "formed\n\n\n"
            "```\n"
            "\nAfter\n"
        )

        cleaned, report = clean_markdown(source)

        self.assertIn("```python\n1\n2025\nwell-\nformed\n\n\n```\n", cleaned)
        self.assertEqual(report.page_numbers_stripped, 0)
        self.assertEqual(report.hyphen_wraps_joined, 0)

    def test_standalone_year_without_page_markers_is_preserved(self) -> None:
        source = "# Publication year\n\n2025\n\nText.\n"

        cleaned, report = clean_markdown(source)

        self.assertIn("\n2025\n", cleaned)
        self.assertEqual(report.page_numbers_stripped, 0)

    def test_bare_page_number_at_marker_region_edge_is_removed(self) -> None:
        source = (
            "<!-- page-marker:1 -->\n"
            "First page body.\n"
            "1\n"
            "<!-- page-marker:2 -->\n"
            "Second page body.\n"
            "2\n"
        )

        cleaned, report = clean_markdown(source)

        self.assertNotIn("\n1\n", cleaned)
        self.assertNotIn("\n2\n", cleaned)
        self.assertEqual(report.page_numbers_stripped, 2)

    def test_repeated_header_requires_ceil_sixty_percent(self) -> None:
        source = "".join(
            (
                f"<!-- page-marker:{i + 1} -->\n"
                f"{'Repeated' if i < 2 else f'Unique {i}'}\n"
                f"Body {i}.\n"
            )
            for i in range(4)
        )

        cleaned, report = clean_markdown(source)

        self.assertEqual(cleaned.count("Repeated"), 2)
        self.assertEqual(report.repeated_headers_stripped, 0)


if __name__ == "__main__":
    unittest.main()
