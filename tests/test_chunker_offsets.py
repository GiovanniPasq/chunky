import re
import unittest

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
