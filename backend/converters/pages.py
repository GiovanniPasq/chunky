"""Common physical-page markers shared by local PDF conversion engines."""
from collections.abc import Iterable


def page_markdown(pages: Iterable[tuple[int, str]], total_pages: int | None = None) -> str:
    by_number = dict(pages)
    count = max(total_pages or 0, max(by_number, default=0))
    return '\n\n---\n\n'.join(
        f'<!-- page-marker:{number} -->\n' + by_number.get(number, "").strip("\r\n")
        for number in range(1, count + 1)
    )
