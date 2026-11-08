import re
import unittest
from unittest.mock import patch

from backend.chunkers.base import TextChunker
from backend.chunkers.langchain_chunker import LangChainChunker
from backend.models.schemas import ChunkRequest, ChunkerType


class ChunkerOffsetTests(unittest.TestCase):
    def test_markdown_spans_follow_normalized_source_whitespace(self) -> None:
        source = '# Title\n\n  Café   text.\nNext line.\n\n## Next\n\nMore text.'
        for sizing in (False, True):
            result = LangChainChunker().chunk(ChunkRequest(
                content=source, chunker_type=ChunkerType.markdown,
                chunk_size=40, chunk_overlap=5, enable_markdown_sizing=sizing,
            ))
            for chunk in result:
                normalize = lambda value: re.sub(r'\s+', ' ', value).strip()
                self.assertEqual(normalize(source[chunk.start:chunk.end]), normalize(chunk.content))
            self.assertGreater(result[-1].start, source.index('## Next') - 1)

    def test_markdown_header_metadata_preserves_unavailable_source_span(self) -> None:
        from langchain_core.documents import Document
        transformed = Document(page_content='Normalized table summary.', metadata={'Header 1': 'Title'})
        with patch('backend.chunkers.langchain_chunker.MarkdownHeaderTextSplitter.split_text', return_value=[transformed]):
            chunk = LangChainChunker().chunk(ChunkRequest(
                content='# Title\n\n| Count |\n| --- |\n| 7 |', chunker_type=ChunkerType.markdown,
            ))[0]
        self.assertEqual((chunk.start, chunk.end), (0, 0))
        self.assertFalse(chunk.metadata['source_span_available'])
        self.assertEqual(chunk.metadata['Header 1'], 'Title')

    def test_repeated_short_chunks_advance_even_with_large_overlap(self) -> None:
        chunks = TextChunker.build_chunks('one one one', ['one', 'one', 'one'], 20)
        self.assertEqual([chunk.start for chunk in chunks], [0, 4, 8])

    def test_character_strategy_splits_a_long_paragraph(self) -> None:
        source = 'a' * 450
        result = LangChainChunker().chunk(ChunkRequest(
            content=source, chunker_type=ChunkerType.character,
            chunk_size=100, chunk_overlap=10,
        ))
        self.assertGreater(len(result), 1)
        for chunk in result:
            self.assertLessEqual(len(chunk.content), 100)
            self.assertEqual(source[chunk.start:chunk.end], chunk.content)


if __name__ == '__main__':
    unittest.main()
