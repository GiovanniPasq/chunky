"""Bulk export requests: saved documents only, with explicit version selection."""
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ExportRequest(BaseModel):
    filenames: list[str] = Field(min_length=1, max_length=5000)
    destination: Literal['download', 'folder'] = 'download'
    include_markdown: bool = True
    include_chunks: bool = True
    include_pdfs: bool = False
    versions: Literal['latest', 'all'] = 'latest'
    folder: str = Field(default='', max_length=120, pattern=r'^[^/\\\x00-\x1f:*?"<>|]*$')

    @model_validator(mode='after')
    def has_contents(self):
        if not (self.include_markdown or self.include_chunks or self.include_pdfs):
            raise ValueError('Select at least one file type to export.')
        return self
