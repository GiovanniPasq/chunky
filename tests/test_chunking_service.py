import unittest
from unittest.mock import patch

from backend.models.schemas import ChunkItem, ChunkRequest, ChunkerLibrary, ChunkerType
from backend.services.chunking_service import ChunkingService


class _FakeChunker:
    constructed = 0

    def __init__(self) -> None:
        type(self).constructed += 1

    def chunk(self, request: ChunkRequest) -> list[ChunkItem]:
        return [ChunkItem(index=0, content=request.content, end=len(request.content))]


class _ExplodingChunker:
    def __init__(self) -> None:
        raise AssertionError("unused chunker should not be initialized")


class ChunkingServiceTests(unittest.TestCase):
    def test_initializes_only_the_requested_library(self) -> None:
        _FakeChunker.constructed = 0
        library_map = {
            ChunkerLibrary.langchain: _FakeChunker,
            ChunkerLibrary.chonkie: _ExplodingChunker,
            ChunkerLibrary.docling: _ExplodingChunker,
        }
        with patch("backend.services.chunking_service._LIBRARY_MAP", library_map):
            service = ChunkingService()
            result = service.chunk_text(ChunkRequest(
                content="hello",
                chunker_type=ChunkerType.token,
                chunker_library=ChunkerLibrary.langchain,
            ))

        self.assertEqual(_FakeChunker.constructed, 1)
        self.assertEqual(result.total_chunks, 1)


if __name__ == "__main__":
    unittest.main()
