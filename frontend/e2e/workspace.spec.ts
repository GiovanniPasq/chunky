import { expect, test } from '@playwright/test'
import { markdown, mockWorkspace, openDocument } from './fixtures'

test.beforeEach(async ({ page }) => {
  await mockWorkspace(page)
})

test('follows system appearance and persists an explicit choice', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('menuitem', { name: 'Light theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('menuitem', { name: 'Dark theme' }).click()
  await openDocument(page)
  await page.waitForFunction(
    () =>
      (document.querySelector('.pdf-page canvas') as HTMLCanvasElement)
        ?.height > 0,
  )
  await expect(page.locator('.pdf-page').first()).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  )
  await page.screenshot({ path: testInfo.outputPath('dark-workspace.png') })
})

test('keeps destructive actions in an accessible menu and confirmation dialog', async ({
  page,
}) => {
  await page.goto('/')
  await openDocument(page)
  const trigger = page.getByRole('button', { name: 'Markdown actions' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('menuitem', { name: 'Export Markdown' }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Delete variant' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete Markdown variant?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})

test('shows unsaved Markdown and protects it when switching documents', async ({
  page,
}) => {
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.md-raw-editor').fill(markdown + '\nEdited note.')
  await expect(page.locator('.workspace-save-state')).toContainText(
    'Unsaved changes',
  )
  await page.getByRole('button', { name: 'Notes.md', exact: true }).click()
  await expect(page.locator('.workspace-context h1')).toHaveText(
    'Annual report.pdf',
  )
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.workspace-save-state')).toContainText(
    'All changes saved',
  )
  await expect(page.locator('.markdown-content')).toContainText('Edited note.')
})

test('distinguishes generated chunks from saved and edited chunks', async ({
  page,
}) => {
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  await expect(page.locator('.chunk-block')).toHaveCount(1)
  await expect(page.locator('.workspace-save-state')).toContainText(
    'Chunks not saved',
  )
  await page.getByRole('button', { name: 'Save chunks', exact: true }).click()
  await expect(page.locator('.workspace-save-state')).toContainText(
    'All changes saved',
  )
  await expect(
    page.getByRole('button', { name: 'Save chunks', exact: true }),
  ).toBeDisabled()
  await page.locator('.chunk-edit-btn').click()
  await page
    .getByRole('textbox', { name: 'Chunk content' })
    .fill('Updated chunk content')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.workspace-save-state')).toContainText(
    'Unsaved changes',
  )
  await expect(
    page.getByRole('button', { name: 'Save chunks', exact: true }),
  ).toBeEnabled()
})

test('shows one full-height viewer on mobile and guards unsaved edits', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await openDocument(page)
  await expect(page.locator('.viewer-panel:visible')).toHaveCount(1)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.md-raw-editor').fill(markdown + 'New text')
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  await expect(page.locator('.md-raw-editor')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  await expect(page.locator('.chunk-block')).toHaveCount(1)
  await expect(page.locator('.viewer-panel:visible')).toHaveCount(1)
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.locator('.pdf-page canvas')).toBeVisible()
  await page.waitForFunction(
    () =>
      (document.querySelector('.pdf-page canvas') as HTMLCanvasElement)
        ?.height > 0,
  )
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('mobile-workspace.png') })
})

test('filters documents using actionable workflow states', async ({ page }) => {
  await page.goto('/')
  await page
    .getByRole('combobox', { name: 'Filter documents by status' })
    .selectOption('needs-conversion')
  await expect(
    page.getByRole('button', { name: 'Unconverted.pdf', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Annual report.pdf', exact: true }),
  ).not.toBeVisible()
  await page
    .getByRole('combobox', { name: 'Filter documents by status' })
    .selectOption('review')
  await expect(
    page.getByRole('button', { name: 'Partial.pdf', exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('.doc-stage').getByText('Needs review', { exact: true }),
  ).toBeVisible()
})

test('explains settings scope and keeps keyboard focus inside the modal', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await openDocument(page)
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await settings.click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(dialog).toContainText(
    'Changing chunking settings regenerates chunks',
  )
  await dialog.getByRole('button', { name: 'Chunking', exact: true }).click()
  const strategy = page.getByRole('combobox', { name: 'Chunker Type' })
  await strategy.selectOption('recursive')
  await page.screenshot({ path: testInfo.outputPath('settings.png') })
  expect(
    await strategy.evaluate((el) => getComputedStyle(el).paddingRight),
  ).toBe('36px')
  await dialog.getByRole('button', { name: 'Apply settings' }).focus()
  await page.keyboard.press('Tab')
  await expect(
    dialog.getByRole('button', { name: 'Close settings' }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(settings).toBeFocused()
})

test('retries chunking after interrupting a first generation', async ({
  page,
}) => {
  const fixture = await mockWorkspace(page, 1200)
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  await expect.poll(fixture.chunkRequests).toBe(1)
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click()
  await page
    .getByRole('button', { name: 'Markdown', exact: true })
    .last()
    .click()
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  await expect.poll(fixture.chunkRequests).toBe(2)
  await expect(page.locator('.chunk-block')).toHaveCount(1)
})

test('updates system theme live while keeping user choices independent', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Appearance' }).click()
  await page.getByRole('menuitem', { name: 'Light theme' }).click()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('preserves an unsaved left-panel draft when crossing the mobile breakpoint', async ({
  page,
}) => {
  await page.goto('/')
  await openDocument(page)
  await page
    .getByRole('group', { name: 'Left panel view' })
    .getByRole('button', { name: 'Markdown' })
    .click()
  const leftPanel = page.locator('.viewer-panel').first()
  await leftPanel.getByRole('button', { name: 'Edit', exact: true }).click()
  const draft = markdown + '\nKeep this draft through resize.'
  await page.locator('.md-raw-editor').fill(draft)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.md-raw-editor')).toHaveValue(draft)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Document view' })).toBeVisible()
  await expect(page.locator('.viewer-panel:visible')).toHaveCount(1)
  await expect(page.locator('.markdown-content:visible')).toContainText(
    'Keep this draft through resize.',
  )
})

test('uses correct size units and disables ignored chunk settings', async ({ page }) => {
  await page.route('**/api/capabilities', route => route.fulfill({ json: {
    converters: [{ name: 'pymupdf', label: 'PyMuPDF', description: 'PDF conversion' }],
    chunkers: [
      { library: 'chonkie', label: 'Chonkie', strategies: [
        { strategy: 'semantic', label: 'Semantic', description: 'Embedding token target' },
        { strategy: 'table', label: 'Table', description: 'Three rows' },
        { strategy: 'neural', label: 'Neural', description: 'Model boundaries' },
        { strategy: 'token', label: 'Token', description: 'GPT-2 windows' },
      ] },
      { library: 'docling', label: 'Docling', strategies: [{ strategy: 'hybrid', label: 'Hybrid', description: 'Document token target' }] },
    ],
  } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'Chunking', exact: true }).click()
  await dialog.locator('.library-option').filter({ hasText: 'Chonkie' }).click()
  await dialog.locator('#chunker-type').selectOption('semantic')
  await expect(dialog.locator('label[for="chunk-size"]')).toContainText('(tokens)')
  await expect(dialog.locator('#chunk-size')).toBeEnabled()
  await expect(dialog.locator('#chunk-overlap')).toBeDisabled()
  await dialog.locator('#chunker-type').selectOption('table')
  await expect(dialog.locator('label[for="chunk-size"]')).toContainText('(rows)')
  await expect(dialog.locator('#chunk-size')).toHaveValue('3')
  await expect(dialog.locator('#chunk-size')).toBeDisabled()
  await dialog.locator('#chunker-type').selectOption('neural')
  await expect(dialog.locator('#chunk-size')).toHaveValue('')
  await expect(dialog.locator('#chunk-overlap')).toBeDisabled()
  await dialog.locator('#chunker-type').selectOption('token')
  await expect(dialog.locator('#chunk-overlap')).toBeEnabled()
  await dialog.locator('.library-option').filter({ hasText: 'Docling' }).click()
  await expect(dialog.locator('label[for="chunk-size"]')).toContainText('(tokens)')
  await expect(dialog.locator('#chunk-size')).toBeEnabled()
  await expect(dialog.locator('#chunk-overlap')).toBeDisabled()
})

test('shows applied processing defaults and opens the relevant settings section', async ({ page }) => {
  let capabilityRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/capabilities') capabilityRequests += 1
  })
  await page.goto('/')
  const summary = page.locator('.processing-settings')
  await expect(summary).toContainText('PyMuPDF')
  await expect(summary).toContainText('LangChain / Token')
  const chunker = page.getByRole('button', { name: /^Chunker settings:/ })
  await chunker.click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(dialog.getByRole('button', { name: 'Chunking', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('combobox', { name: 'Chunker Type' }).selectOption('recursive')
  await expect(summary).toContainText('LangChain / Token')
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(chunker).toBeFocused()
  await chunker.click()
  await expect(dialog.getByRole('combobox', { name: 'Chunker Type' })).toHaveValue('token')
  await dialog.getByRole('combobox', { name: 'Chunker Type' }).selectOption('recursive')
  await dialog.getByRole('spinbutton', { name: /Chunk Size/ }).fill('768')
  await dialog.getByRole('spinbutton', { name: /Overlap/ }).fill('64')
  await dialog.getByRole('button', { name: 'Apply settings' }).click()
  await expect(summary).toContainText('LangChain / Recursive')
  await expect(chunker).toHaveAttribute('aria-label', /768 chars · 64 overlap/)
  await page.getByRole('button', { name: /^Converter settings:/ }).click()
  await expect(dialog.getByRole('button', { name: 'Conversion', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  expect(capabilityRequests).toBe(1)
  await page.reload()
  await expect(summary).toContainText('LangChain / Recursive')
  await expect(chunker).toHaveAttribute('aria-label', /768 chars · 64 overlap/)
})

test('shares recovered capability labels between settings and the summary', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/capabilities', route => {
    attempts += 1
    if (attempts <= 2) return route.fulfill({ status: 503, body: 'Unavailable' })
    return route.fulfill({ json: {
      converters: [{ name: 'pymupdf', label: 'PDF Engine', description: 'Converter label from the server' }],
      chunkers: [{ library: 'langchain', label: 'LangChain', strategies: [
        { strategy: 'token', label: 'Token', description: 'Token windows' },
      ] }],
    } })
  })
  await page.goto('/')
  await expect.poll(() => attempts).toBe(1)
  const summary = page.locator('.processing-settings')
  await expect(summary).toContainText('pymupdf')
  await page.getByRole('button', { name: /^Converter settings:/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: /Retry/ }).click()
  await expect(dialog.getByRole('button', { name: /PDF Engine/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(summary).toContainText('PDF Engine')
  expect(attempts).toBe(3)
})

test('exports saved documents to ZIP and a backend folder', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }) })
  const requests: Record<string, unknown>[] = []
  await page.route('**/api/export/config', route => route.fulfill({ json: { directory: '/workspace/exports' } }))
  await page.route('**/api/export', route => {
    const request = route.request().postDataJSON()
    requests.push(request)
    return request.destination === 'folder'
      ? route.fulfill({ json: { directory: '/workspace/exports/dataset/chunky-export' } })
      : route.fulfill({ body: 'test ZIP download', contentType: 'application/zip' })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Export all', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export documents', exact: true })
  await expect(dialog).toContainText('4 documents selected')
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download ZIP', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('chunky-export.zip')
  expect(requests[0].filenames).toEqual(['Annual report.pdf', 'Notes.md', 'Unconverted.pdf', 'Partial.pdf'])
  await page.getByRole('button', { name: 'Export all', exact: true }).click()
  await dialog.getByLabel('Destination', { exact: true }).selectOption('folder')
  await dialog.getByLabel('Subfolder (optional)', { exact: true }).fill('dataset')
  await dialog.getByLabel('Versions', { exact: true }).selectOption('all')
  await dialog.getByRole('button', { name: 'Export to folder', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('/workspace/exports/dataset/chunky-export')
  expect(requests[1]).toMatchObject({ destination: 'folder', folder: 'dataset', versions: 'all' })
})

test('does not export unsaved changes or hidden selected documents', async ({ page }) => {
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.md-raw-editor').fill('Unsaved document')
  await page.getByRole('button', { name: 'Export all', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Export documents' })).not.toBeVisible()
  await expect(page.getByText(/Save or cancel the active Markdown and chunk changes/)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search documents' }).fill('Notes.md')
  await page.getByRole('button', { name: 'Export selected (1)', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Export documents' })).toContainText('1 document selected')
})

test('Alt/Option arrows navigate focused document rows and respect filters and dialogs', async ({ page }) => {
  await page.goto('/')
  await openDocument(page)
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.workspace-context h1')).toHaveText('Notes.md')
  await expect(page.getByRole('button', { name: 'Notes.md', exact: true })).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.locator('.workspace-context h1')).toHaveText('Annual report.pdf')
  const search = page.getByRole('textbox', { name: 'Search documents' })
  await search.fill('.pdf')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.workspace-context h1')).toHaveText('Annual report.pdf')
  await page.getByRole('button', { name: 'Annual report.pdf', exact: true }).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.workspace-context h1')).toHaveText('Unconverted.pdf')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.workspace-context h1')).toHaveText('Unconverted.pdf')
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('button', { name: 'Unconverted.pdf', exact: true }).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.workspace-context h1')).toHaveText('Unconverted.pdf')
})

test('generates and saves a reviewed summary before previewing Markdown enrichment', async ({ page }) => {
  let summary: Record<string, unknown> | null = null
  let saved = false
  const record = (topic: string, narrative: string) => ({
    filename: 'Annual report_pymupdf4llm.md', doc_stem: 'Annual report',
    summary: { topic, narrative }, status: { user_edited: saved, generated_at: '2026-11-08T00:00:00Z' },
  })
  await page.route('**/api/enrich/summary?*', route => summary
    ? route.fulfill({ json: summary })
    : route.fulfill({ status: 404, json: { detail: 'No summary' } }))
  await page.route('**/api/enrich/summary', async route => {
    const fields = route.request().postDataJSON().summary
    saved = true
    summary = record(fields.topic, fields.narrative)
    return route.fulfill({ json: summary })
  })
  await page.route('**/api/enrich/summary/generate', async route => {
    summary = record('Annual report', 'A factual summary of the annual report.')
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'done', summary })}\n\n` })
  })
  let pipeline: Record<string, unknown> | null = null
  await page.route('**/api/enrich/markdown/pipeline', async route => {
    pipeline = route.request().postDataJSON()
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({
      type: 'done', enriched_content: markdown + '\nReviewed.',
      stats: { pieces: 1, cached_pieces: 0, failed_pieces: [], cleanup_report: {} },
    })}\n\n` })
  })
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Enrich', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review document summary' })
  await dialog.getByRole('button', { name: 'Generate summary', exact: true }).click()
  await expect(dialog.getByLabel('Topic', { exact: true })).toHaveValue('Annual report')
  await dialog.getByLabel('Narrative', { exact: true }).fill('Reviewed factual summary.')
  await dialog.getByRole('button', { name: 'Confirm & enrich', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Review enrichment changes' })).toBeVisible()
  expect(saved).toBe(true)
  expect(summary?.summary).toMatchObject({ narrative: 'Reviewed factual summary.' })
  expect(pipeline).toMatchObject({ use_summary: true, filename: 'Annual report_pymupdf4llm.md' })
})

test('retries a failed summary regeneration without silently using the old cache', async ({ page }) => {
  const record = { filename: 'Annual report_pymupdf4llm.md', doc_stem: 'Annual report',
    summary: { topic: 'Old summary', narrative: 'Previous reviewed narrative.' },
    status: { user_edited: false, generated_at: '2026-11-08T00:00:00Z' } }
  const forced: boolean[] = []
  await page.route('**/api/enrich/summary?*', route => route.fulfill({ json: record }))
  await page.route('**/api/enrich/summary/generate', async route => {
    forced.push(route.request().postDataJSON().force)
    const event = forced.length === 1
      ? { type: 'error', status: 502, message: 'Summary generation did not complete. Please retry.' }
      : { type: 'done', summary: { ...record, summary: { topic: 'New summary', narrative: 'New narrative.' } } }
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(event)}\n\n` })
  })
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Enrich', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review document summary' })
  await expect(dialog.getByLabel('Topic', { exact: true })).toHaveValue('Old summary')
  await dialog.getByRole('button', { name: 'Regenerate', exact: true }).click()
  await expect(dialog.getByText('Summary generation did not complete. Please retry.', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(dialog.getByLabel('Topic', { exact: true })).toHaveValue('New summary')
  expect(forced).toEqual([true, true])
})

for (const width of [1440, 390]) {
  test(`wraps long Markdown table cells within the viewer at ${width}px`, async ({ page }) => {
    const paragraph = 'Keep the original source details readable when reviewing a converted document. '.repeat(12).trim()
    const content = '# Annual report\n\n| Field | Description |\n| --- | --- |\n'
      + `| First field | ${paragraph} |\n| Second field | ${paragraph} |\n| Last field | Final source details. |`
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/document/*', route => route.fulfill({ json: {
      pdf_filename: 'Annual report.pdf', md_filename: 'Annual report_pymupdf4llm.md',
      md_content: content, has_pdf: true, has_markdown: true,
    } }))
    await page.route('**/api/documents/*/markdowns/*', route => route.fulfill({ json: {
      filename: 'Annual report_pymupdf4llm.md', content, source: 'converted', converter: 'pymupdf4llm',
    } }))
    await page.goto('/')
    if (width < 640) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await openDocument(page)
    const table = page.locator('.markdown-content table')
    await expect(table.locator('tbody tr')).toHaveCount(3)
    await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText(paragraph)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      const dimensions = await table.evaluate(element => {
        const viewer = element.closest('.md-viewer')!
        return { table: element.getBoundingClientRect().width, viewer: viewer.clientWidth, scrollWidth: viewer.scrollWidth }
      })
      expect(dimensions.table).toBeLessThanOrEqual(dimensions.viewer)
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewer + 1)
    }
  })
}

test('confirms deleting all documents and prevents duplicate requests while deleting', async ({ page }) => {
  let documents = ['Annual report.pdf', 'Notes.md', 'Unconverted.pdf', 'Partial.pdf']
  const requests: string[][] = []
  let finishDelete: (() => void) | undefined
  await page.route('**/api/documents', async route => {
    if (route.request().method() !== 'DELETE') return route.fulfill({ json: documents })
    const filenames: string[] = route.request().postDataJSON()
    requests.push(filenames)
    await new Promise<void>(resolve => { finishDelete = resolve })
    documents = documents.filter(filename => !filenames.includes(filename))
    return route.fulfill({ json: { success: true, deleted: filenames, deleted_documents: filenames, failed: {}, message: 'Deleted' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  const trigger = page.getByRole('button', { name: 'Delete (4)', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Delete all documents?', exact: true })
  await expect(dialog).toContainText('delete 4 documents')
  await expect(dialog).toContainText('cannot be undone')
  expect(requests).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(requests).toHaveLength(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await dialog.getByRole('button', { name: 'Delete documents', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(dialog.getByRole('button', { name: 'Deleting…', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  finishDelete!()
  await expect(dialog).not.toBeVisible()
  expect(requests).toEqual([['Annual report.pdf', 'Notes.md', 'Unconverted.pdf', 'Partial.pdf']])
  await expect(page.getByRole('button', { name: 'Annual report.pdf', exact: true })).toHaveCount(0)
})

test('bulk document deletion confirms only the visible selection', async ({ page }) => {
  const requests: string[][] = []
  await page.route('**/api/documents', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const filenames: string[] = route.request().postDataJSON()
    requests.push(filenames)
    return route.fulfill({ json: { success: false, deleted: [], deleted_documents: [],
      failed: Object.fromEntries(filenames.map(filename => [filename, 'Delete failed'])), message: 'Delete failed' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search documents' }).fill('Notes.md')
  await page.getByRole('button', { name: 'Delete (1)', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete selected documents?', exact: true })
  await expect(dialog).toContainText('delete 1 document?')
  expect(requests).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Delete documents', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(requests).toEqual([['Notes.md']])
  await expect(page.getByRole('button', { name: 'Delete (1)', exact: true })).toBeEnabled()
})

test('confirms deleting all chunks and preserves them when cancelled', async ({ page }) => {
  await page.goto('/')
  await openDocument(page)
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  await expect(page.locator('.chunk-block')).toHaveCount(1)
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  const trigger = page.locator('button[title="Delete selected chunks"]')
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Delete all chunks?', exact: true })
  await expect(dialog).toContainText('delete 1 chunk from the current chunk set')
  await expect(page.locator('.chunk-block')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.chunk-block')).toHaveCount(1)
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.chunk-block')).toHaveCount(1)
  await trigger.click()
  await dialog.getByRole('button', { name: 'Delete chunks', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.chunk-block')).toHaveCount(0)
  await expect(page.locator('.workspace-save-state')).toContainText('Unsaved changes')
})

for (const width of [1440, 1280, 1024, 390]) {
  test(`keeps the Markdown version selector beside zoom at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    if (width < 640) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await openDocument(page)
    const picker = page.getByRole('combobox', { name: 'Markdown version', exact: true })
    const tools = page.locator('.panel-label-tools').filter({ has: picker })
    const alignment = await tools.evaluate(element => {
      const version = element.querySelector('select')!.getBoundingClientRect()
      const zoom = element.querySelector('.panel-zoom')!.getBoundingClientRect()
      return { versionMiddle: version.y + version.height / 2, zoomMiddle: zoom.y + zoom.height / 2,
        versionRight: version.right, zoomLeft: zoom.left }
    })
    expect(Math.abs(alignment.versionMiddle - alignment.zoomMiddle)).toBeLessThan(1)
    expect(alignment.versionRight).toBeLessThan(alignment.zoomLeft)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
