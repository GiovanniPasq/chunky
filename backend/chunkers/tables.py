"""Adapt row-based table splitting to full Markdown documents."""

import re

from backend.models.schemas import ChunkItem


def table_chunks(content: str) -> list[ChunkItem]:
    from chonkie import TableChunker
    from markdown_it import MarkdownIt

    parser = MarkdownIt('commonmark').enable('table')
    # Markdown normalizes CR/LF, but does not treat Unicode paragraph
    # separators as source lines. Keep its line maps aligned to the input.
    lines = [line for line in re.findall(r'[^\r\n]*(?:\r\n|\r|\n|$)', content) if line]
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    tables = [token.map for token in parser.parse(content) if token.type == 'table_open']
    native = TableChunker(tokenizer='row', chunk_size=3)
    items = []
    cursor = 0

    def prose(start: int, end: int) -> None:
        text = content[start:end]
        if text.strip():
            items.append(ChunkItem(index=len(items), content=text, start=start, end=end))

    for first, last in tables:
        table_start, table_end = starts[first], starts[last]
        prose(cursor, table_start)
        if last - first <= 2:
            prose(table_start, table_end)
            cursor = table_end
            continue
        # Chonkie's standalone parser expects leading pipes. Markdown allows
        # them to be omitted; normalize only the grouping input, not the output.
        canonical = '\n'.join(
            line.lstrip() if line.lstrip().startswith('|') else '|' + line.lstrip()
            for line in (line.rstrip('\r\n') for line in lines[first:last])
        ) + '\n'
        row = first + 2
        header = content[table_start:starts[row]]
        for group in native.chunk(canonical):
            count = group.token_count
            end_row = min(row + count, last)
            body_start, body_end = starts[row], starts[end_row]
            items.append(ChunkItem(
                index=len(items), content=header + content[body_start:body_end],
                start=table_start if row == first + 2 else body_start,
                end=body_end, metadata={'row_count': count},
            ))
            row = end_row
        cursor = table_end
    prose(cursor, len(content))
    return items
