import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnrichmentSettings } from '../../types'
import { apiEnrichMarkdownPipeline } from '../../services/apiService'
import { saveMarkdownFile } from '../../services/documentsApi'
import { runBulkMarkdownEnrich } from './runBulkMarkdownEnrich'

vi.mock('../../services/apiService', () => ({
  apiEnrichMarkdownPipeline: vi.fn(),
}))

vi.mock('../../services/documentsApi', () => ({
  saveMarkdownFile: vi.fn(),
}))

describe('runBulkMarkdownEnrich', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('honours checkpoint settings and reports partial saved results', async () => {
    vi.mocked(apiEnrichMarkdownPipeline).mockResolvedValue({
      enrichedContent: '# corrected',
      stats: {
        pieces: 2,
        cached_pieces: 0,
        failed_pieces: [2],
        cleanup: {},
      },
    })
    vi.mocked(saveMarkdownFile).mockResolvedValue()
    const showToast = vi.fn()
    const settings: EnrichmentSettings = {
      model: 'test-model',
      use_checkpoint: false,
    }
    const onSuccess = vi.fn()

    await runBulkMarkdownEnrich({
      filenames: ['report.pdf'],
      enrichSettings: settings,
      signal: new AbortController().signal,
      setBulkOp: vi.fn(),
      setBulkConnectionLost: vi.fn(),
      showToast,
      resolveMarkdownFilename: vi.fn().mockResolvedValue('report_vlm.md'),
      onSuccess,
      onProgress: vi.fn(),
      onResult: vi.fn(),
    })

    expect(apiEnrichMarkdownPipeline).toHaveBeenCalledWith(
      'report_vlm.md',
      'report.pdf',
      settings,
      false,
      true,
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    )
    expect(showToast).toHaveBeenCalledWith(
      '1 file saved with uncorrected pieces after LLM failures',
      'error',
    )
    expect(onSuccess).toHaveBeenCalledWith(new Set(['report.pdf']))
  })

  it('reports version lookup failures separately from missing Markdown', async () => {
    const showToast = vi.fn()
    const onResult = vi.fn()

    await runBulkMarkdownEnrich({
      filenames: ['report.pdf'],
      enrichSettings: { model: 'test-model' },
      signal: new AbortController().signal,
      setBulkOp: vi.fn(),
      setBulkConnectionLost: vi.fn(),
      showToast,
      resolveMarkdownFilename: vi.fn().mockRejectedValue(new Error('backend unavailable')),
      onSuccess: vi.fn(),
      onProgress: vi.fn(),
      onResult,
    })

    expect(apiEnrichMarkdownPipeline).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith('report.pdf', false)
    expect(showToast).toHaveBeenCalledWith(
      '1 file failed while checking Markdown versions',
      'error',
    )
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringContaining('no markdown found'),
      expect.anything(),
    )
  })
})
