"""Unicode-safe windows for the GPT-2 and native byte-based splitters."""

from bisect import bisect_left, bisect_right
import codecs

from fastapi import HTTPException

from backend.models.schemas import ChunkItem


def token_windows(content: str, size: int, overlap: int) -> list[ChunkItem]:
    """Apply GPT-2 token budgets while keeping complete source characters.

    A UTF-8 character can span several BPE tokens. Window ends move backwards
    to a character boundary; overlap starts move forwards to one. Thus overlap
    is a target and may be smaller when its boundary crosses a character.
    """
    import tiktoken

    encoding = tiktoken.get_encoding('gpt2')
    # Documents containing tokenizer control strings are still ordinary text.
    tokens = encoding.encode(content, disallowed_special=())
    if not tokens:
        return []
    decoder = codecs.getincrementaldecoder('utf-8')()
    token_edges = [0]
    char_edges = [0]
    char_position = 0
    for index, token in enumerate(tokens, 1):
        char_position += len(decoder.decode(encoding.decode_single_token_bytes(token)))
        if not decoder.getstate()[0]:
            token_edges.append(index)
            char_edges.append(char_position)

    chunks = []
    start = 0
    while token_edges[start] < len(tokens):
        end = bisect_right(token_edges, token_edges[start] + size) - 1
        while end > start:
            text = content[char_edges[start]:char_edges[end]]
            count = len(encoding.encode(text, disallowed_special=()))
            if count <= size:
                break
            end -= 1
        if end <= start:
            raise HTTPException(400, 'Chunk size is too small for a complete Unicode character; increase the token budget.')
        chunks.append(ChunkItem(
            index=len(chunks), content=text,
            start=char_edges[start], end=char_edges[end],
            metadata={'token_count': count},
        ))
        if token_edges[end] == len(tokens):
            break
        start = max(start + 1, bisect_left(token_edges, token_edges[end] - overlap))
    return chunks


def fast_windows(content: str, size: int) -> list[ChunkItem]:
    """Use Chonkie's native byte offsets without decoding partial UTF-8.

    Moving a byte boundary to the end of its character can exceed the native
    byte-size target by at most three bytes. No source bytes are discarded.
    """
    import chonkie_core

    data = content.encode('utf-8')
    offsets = chonkie_core.chunk_offsets(data, size=size, delimiters='\n.?')
    chunks = []
    byte_start = char_start = 0
    for _, byte_end in offsets:
        while byte_end < len(data) and data[byte_end] & 0xC0 == 0x80:
            byte_end += 1
        if byte_end <= byte_start:
            continue
        text = data[byte_start:byte_end].decode('utf-8')
        chunks.append(ChunkItem(
            index=len(chunks), content=text, start=char_start, end=char_start + len(text),
            metadata={'byte_count': byte_end - byte_start},
        ))
        byte_start = byte_end
        char_start += len(text)
    return chunks
