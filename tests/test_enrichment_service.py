from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

import httpx

from backend.services.chunk_context import ChunkSurroundingContext
from backend.services.document_summary import DocumentSummary
from backend.services.enrichment_service import EnrichmentService, _CHUNK_SYSTEM, _PIECE_SYSTEM


def completion(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


class EnrichmentServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient()

    async def asyncTearDown(self):
        await self.client.aclose()

    def service(self, output, prompt=None):
        service = EnrichmentService(user_prompt=prompt, http_client=self.client)
        service._complete = AsyncMock(return_value=completion(output))
        return service

    async def test_displayed_default_prompts_still_receive_summary_and_neighbors(self):
        summary = DocumentSummary(topic='Space research', narrative='A report about satellites.')
        piece = self.service('A satellite.', _PIECE_SYSTEM)
        await piece.enrich_piece('A satellite.', document_summary=summary)
        messages = piece._complete.call_args.args[0]
        self.assertIn('TOPIC: Space research', messages[1]['content'])
        self.assertIn('DOCUMENT SUMMARY', messages[0]['content'])

        chunk = self.service('{"title":"Satellite"}', _CHUNK_SYSTEM)
        await chunk.enrich_chunk('A satellite.', document_summary=summary,
                                 surrounding_context=ChunkSurroundingContext(before='Launch', after='Orbit'))
        messages = chunk._complete.call_args.args[0]
        self.assertIn('TOPIC: Space research', messages[1]['content'])
        self.assertIn('BEFORE:\nLaunch', messages[1]['content'])
        self.assertIn('AFTER:\nOrbit', messages[1]['content'])

    async def test_custom_prompt_keeps_its_original_message_contract(self):
        service = self.service('{"title":"Satellite"}', 'My own prompt')
        await service.enrich_chunk('A satellite.', document_summary=DocumentSummary(topic='Space'),
                                   surrounding_context=ChunkSurroundingContext(before='Launch'))
        messages = service._complete.call_args.args[0]
        self.assertEqual(messages[0]['content'], 'My own prompt')
        self.assertEqual(messages[1]['content'], 'A satellite.')

    async def test_correction_preserves_legitimate_code_fences_and_boundary_whitespace(self):
        for source in ('```python\nprint("hello")\n```\n\n', '```markdown\n# Example\n```\n',
                       'Example:\n\n```js\nlet x = 1\n```\n'):
            with self.subTest(source=source):
                service = self.service(source.strip())
                self.assertEqual(await service.enrich_piece(source), source)

    async def test_correction_unwraps_prose_and_keeps_empty_output_source(self):
        service = self.service('```markdown\n# Title\n\nBody.\n```')
        self.assertEqual(await service.enrich_piece('# Title\n\nBody.\n\n'), '# Title\n\nBody.\n\n')
        service = self.service('   ')
        self.assertEqual(await service.enrich_piece('Body.\n\n'), 'Body.\n\n')

    async def test_chunk_json_field_types_cannot_erase_source_or_break_api_contract(self):
        service = self.service('{"cleaned_chunk":null,"title":{},"context":23,"summary":null,'
                               '"keywords":[" orbit ",null,{},5],"questions":"bad type"}')
        result = await service.enrich_chunk('Original text')
        self.assertEqual(result, dict(cleaned_chunk='Original text', title='', context='', summary='',
                                      keywords=['orbit'], questions=[]))
        service = self.service('{"cleaned_chunk":"   "}')
        self.assertEqual((await service.enrich_chunk('Original'))['cleaned_chunk'], 'Original')

    async def test_chunk_truncated_json_salvages_complete_fields_and_preserves_source(self):
        service = self.service('{"title":"Satellite","summary":"unfinished')
        result = await service.enrich_chunk('Original')
        self.assertEqual(result['title'], 'Satellite')
        self.assertEqual(result['cleaned_chunk'], 'Original')
        self.assertEqual(result['summary'], '')

    async def test_summary_and_chunk_reject_non_object_json(self):
        for raw in ('null', '[]', '"text"'):
            with self.subTest(raw=raw):
                service = self.service(raw)
                with self.assertRaises(ValueError):
                    await service.extract_piece_summary('Section')
                with self.assertRaises(ValueError):
                    await service.reduce_extractions(topic_hints=['Research'], narratives=['Section'])
                with self.assertRaises(ValueError):
                    await service.enrich_chunk('Original')

    async def test_null_summary_fields_are_not_saved_as_none_strings(self):
        service = self.service('{"topic_hints":[],"narrative":null}')
        with self.assertRaises(ValueError):
            await service.extract_piece_summary('Section')
        service = self.service('{"topic":null,"narrative":{}}')
        with self.assertRaises(ValueError):
            await service.reduce_extractions(topic_hints=['Research'], narratives=['Section'])
        self.assertTrue(DocumentSummary.from_dict({'topic': None, 'narrative': {}}).is_empty())

    async def test_empty_extraction_is_reported_as_failure_instead_of_missing_summary_context(self):
        service = self.service('{"topic_hints":[],"narrative":""}')
        with self.assertRaises(ValueError):
            await service.extract_piece_summary('A section with substantive text.')


if __name__ == '__main__':
    unittest.main()
