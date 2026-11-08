import random
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
import tiktoken

from backend.chunkers.base import TextChunker
from backend.chunkers.chonkie_chunker import ChonkieChunker
from backend.chunkers.docling_chunker import DoclingChunker
from backend.chunkers.langchain_chunker import LangChainChunker
from backend.models.schemas import ChunkFilesRequest, ChunkRequest, ChunkerLibrary, ChunkerType
from backend.services.chunk_context import build_chunk_surrounding_context
from backend.utils.naming import params_used_by


class ChunkingStrategyTests(unittest.TestCase):
    def token_chunks(self, source, size=40, overlap=15):
        for library, chunker in [('langchain', LangChainChunker()), ('chonkie', ChonkieChunker())]:
            with self.subTest(library=library):
                yield chunker.chunk(ChunkRequest(
                    content=source, chunker_library=ChunkerLibrary(library),
                    chunker_type=ChunkerType.token, chunk_size=size, chunk_overlap=overlap,
                ))

    def assert_source_spans(self, source, chunks):
        self.assertTrue(chunks)
        covered_until = 0
        for index, chunk in enumerate(chunks):
            self.assertEqual(index, chunk.index)
            self.assertEqual(source[chunk.start:chunk.end], chunk.content)
            self.assertLessEqual(chunk.start, covered_until)
            self.assertGreater(chunk.end, covered_until)
            covered_until = chunk.end
        self.assertEqual(covered_until, len(source))

    def test_token_offsets_follow_variable_length_overlap(self):
        words = ['a', 'the', 'encyclopedia', 'pneumonoultramicroscopicsilicovolcanoconiosis',
                 'retrieval', 'documentation', 'ab', 'synchronization', '123']
        source = ' '.join(random.Random(7).choices(words, k=250))
        for chunks in self.token_chunks(source):
            self.assert_source_spans(source, chunks)

    def test_token_windows_preserve_unicode_and_respect_token_budget(self):
        source = ('你好 😀 café 日本語 🧑🏽‍💻 — text. ' * 15) + '<|endoftext|>'
        encoding = tiktoken.get_encoding('gpt2')
        for chunks in self.token_chunks(source):
            self.assert_source_spans(source, chunks)
            for chunk in chunks:
                self.assertNotIn('\ufffd', chunk.content)
                count = len(encoding.encode(chunk.content, disallowed_special=()))
                self.assertLessEqual(count, 40)
                self.assertEqual(chunk.metadata['token_count'], count)

    def test_ascii_token_windows_match_the_native_library(self):
        from langchain_text_splitters import TokenTextSplitter

        source = ' '.join(f'word{index}' for index in range(60))
        expected = TokenTextSplitter(chunk_size=40, chunk_overlap=15).split_text(source)
        for chunks in self.token_chunks(source):
            self.assertEqual([chunk.content for chunk in chunks], expected)

    def test_impossible_unicode_token_budget_is_explained(self):
        for library, chunker in [('langchain', LangChainChunker()), ('chonkie', ChonkieChunker())]:
            with self.subTest(library=library), self.assertRaises(HTTPException) as error:
                chunker.chunk(ChunkRequest(
                    content='😀', chunker_library=library, chunker_type='token', chunk_size=1, chunk_overlap=0,
                ))
            self.assertEqual(error.exception.status_code, 400)
            self.assertIn('Unicode', error.exception.detail)

    def test_fast_windows_preserve_every_utf8_byte(self):
        source = '你好😀 café.\n' * 20
        for size in (1, 3, 7, 40):
            with self.subTest(size=size):
                chunks = ChonkieChunker().chunk(ChunkRequest(
                    content=source, chunker_library='chonkie', chunker_type='fast',
                    chunk_size=size, chunk_overlap=0,
                ))
                self.assert_source_spans(source, chunks)
                self.assertEqual(''.join(chunk.content for chunk in chunks), source)
                for chunk in chunks:
                    self.assertLessEqual(len(chunk.content.encode('utf-8')), size + 3)

    def test_tables_preserve_prose_and_split_rows_with_repeated_headers(self):
        header = 'Name | Count\n--- | ---\n'
        rows = ''.join(f'Item {index} | {index}\n' for index in range(8))
        source = 'Intro\n\n' + header + rows + '\nOutro'
        chunks = ChonkieChunker().chunk(ChunkRequest(
            content=source, chunker_library='chonkie', chunker_type='table', chunk_size=1, chunk_overlap=99,
        ))
        self.assertEqual(len(chunks), 5)
        self.assertEqual(chunks[0].content, 'Intro\n\n')
        self.assertEqual(chunks[-1].content, '\nOutro')
        tables = chunks[1:-1]
        self.assertEqual([chunk.metadata['row_count'] for chunk in tables], [3, 3, 2])
        for chunk in tables:
            self.assertTrue(chunk.content.startswith(header))
            self.assertIn(source[chunk.start:chunk.end], chunk.content)
        for index in range(8):
            self.assertEqual(sum(f'Item {index} | {index}' in chunk.content for chunk in chunks), 1)

    def test_table_line_maps_preserve_crlf_and_unicode_paragraph_separators(self):
        for newline in ('\n', '\r\n', '\r'):
            with self.subTest(newline=repr(newline)):
                header = f'| A | B |{newline}| --- | --- |{newline}'
                source = f'Intro\u2028inside a paragraph.{newline}{newline}' + header + ''.join(
                    f'| café {index} | 😀 |{newline}' for index in range(7)
                )
                chunks = ChonkieChunker().chunk(ChunkRequest(
                    content=source, chunker_library='chonkie', chunker_type='table',
                ))
                self.assertEqual(chunks[1].start, source.index('| A |'))
                self.assertEqual([chunk.metadata['row_count'] for chunk in chunks[1:]], [3, 3, 1])
                for chunk in chunks:
                    self.assertIn(source[chunk.start:chunk.end], chunk.content)

    def test_table_like_code_fences_are_not_split_as_tables(self):
        source = 'Example:\n\n```markdown\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n'
        chunks = ChonkieChunker().chunk(ChunkRequest(
            content=source, chunker_library='chonkie', chunker_type='table',
        ))
        self.assertEqual([chunk.content for chunk in chunks], [source])

    def test_line_based_chunking_keeps_original_log_lines(self):
        from docling_core.transforms.chunker.tokenizer.base import BaseTokenizer

        class CharacterTokenizer(BaseTokenizer):
            def count_tokens(self, text):
                return len(text)

            def get_max_tokens(self):
                return 80

            def get_tokenizer(self):
                return None

        source = ''.join(f'INFO event {index:02d} finished\n' for index in range(20))
        # Use Docling's real line splitter with a deterministic local tokenizer;
        # no network model download is needed in the regression suite.
        chunker = object.__new__(DoclingChunker)
        with patch.object(chunker, '_make_tokenizer', return_value=CharacterTokenizer()):
            chunks = chunker.chunk(ChunkRequest(
                content=source, chunker_library='docling', chunker_type='line_based',
                chunk_size=80, chunk_overlap=99,
            ))
        self.assert_source_spans(source, chunks)
        self.assertEqual(''.join(chunk.content for chunk in chunks), source)
        for chunk in chunks:
            self.assertTrue(chunk.content.endswith('\n'))
            self.assertLessEqual(len(chunk.content), 80)

    def test_code_byte_offsets_are_mapped_to_source_characters(self):
        from types import SimpleNamespace

        source = 'def café():\n    return "你好😀"\n\ndef next_value():\n    return 2\n'
        split = source.index('def next_value')

        class NativeCodeChunks:
            def __init__(self, **options):
                pass

            def chunk(self, text):
                return [SimpleNamespace(
                    text=text[start:end], start_index=len(text[:start].encode()),
                    end_index=len(text[:end].encode()), token_count=end-start,
                ) for start, end in [(0, split), (split, len(text))]]

        with patch('chonkie.CodeChunker', NativeCodeChunks):
            chunks = ChonkieChunker().chunk(ChunkRequest(
                content=source, chunker_library='chonkie', chunker_type='code',
                chunk_size=100, chunk_overlap=0,
            ))
        self.assert_source_spans(source, chunks)
        self.assertEqual(chunks[1].start, split)

    def test_transformed_content_does_not_invent_source_offsets(self):
        source = '| Count |\n| --- |\n| 7 |'
        chunk = TextChunker.build_chunks(source, ['The count is seven.'], 0)[0]
        self.assertEqual((chunk.start, chunk.end), (0, 0))
        self.assertFalse(chunk.metadata['source_span_available'])
        context = build_chunk_surrounding_context(
            source, content=chunk.content, start=chunk.start, end=chunk.end,
            before_chars=100, after_chars=100,
        )
        self.assertTrue(context.is_empty())

    def test_saved_semantic_versions_omit_the_ignored_overlap(self):
        import hashlib
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from backend.models.schemas import SaveChunksRequest
        from backend.services.chunk_storage_service import ChunkStorageService

        with TemporaryDirectory() as folder:
            root = Path(folder)
            service = ChunkStorageService()
            service._mds_dir = root / 'mds'
            service._chunks_dir = root / 'chunks'
            service._mds_dir.mkdir()
            source = 'Review source chunks before indexing.'
            (service._mds_dir / 'notes.md').write_text(source)
            result = service.save_chunks(SaveChunksRequest(
                filename='notes.md', md_filename='notes.md',
                source_hash=hashlib.sha256(source.encode()).hexdigest(),
                chunker_library='chonkie', chunker_type='semantic',
                chunk_size=80, chunk_overlap=99,
                chunks=[{'index': 0, 'content': source, 'start': 0, 'end': len(source)}],
            ))
            self.assertTrue(result.path.endswith('chonkie-semantic_80.json'))
            version = service.list_versions('notes.md')[0]
            self.assertEqual(version.chunk_size, 80)
            self.assertIsNone(version.chunk_overlap)

    def test_ignored_overlap_is_not_validated_or_used_for_semantic_versions(self):
        self.assertEqual(params_used_by('chonkie', 'semantic', False), (True, False))
        for cls, content in [(ChunkRequest, {'content': 'text'}), (ChunkFilesRequest, {'filenames': ['test.md']})]:
            cls(**content, chunker_library='chonkie', chunker_type='semantic', chunk_size=40, chunk_overlap=99)
            cls(**content, chunker_library='langchain', chunker_type='markdown', chunk_size=40,
                chunk_overlap=99, enable_markdown_sizing=False)
            with self.assertRaises(ValidationError):
                cls(**content, chunker_library='langchain', chunker_type='token', chunk_size=40, chunk_overlap=99)
            with self.assertRaises(ValidationError):
                cls(**content, chunker_library='langchain', chunker_type='markdown', chunk_size=40,
                    chunk_overlap=99, enable_markdown_sizing=True)


if __name__ == '__main__':
    unittest.main()
