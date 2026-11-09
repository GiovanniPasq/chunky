import { expect, test, type Page } from '@playwright/test'
import { markdown, mockWorkspace, openDocument } from './fixtures'

async function openPreview(page: Page, original = markdown, enriched = `${original}\nCorrected.`) {
  await mockWorkspace(page, 0, original)
  await page.route('**/api/enrich/markdown/pipeline', route => route.fulfill({
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'done', enriched_content: enriched,
      stats: { pieces: 1, cached_pieces: 0, failed_pieces: [], cleanup: {} },
    })}\n\n`,
  }))
  await page.goto('/')
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
  }
  await openDocument(page)
  await page.getByRole('button', { name: 'Enrich', exact: true }).click()
  await page.getByRole('button', { name: 'Skip — enrich without summary', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review enrichment changes' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('correction preview preserves the source until accepted and keeps edited output after a failed save', async ({ page }) => {
  const writes: string[] = []
  let failSave = true
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().includes('/markdowns/')) writes.push(request.postDataJSON().content)
  })
  const dialog = await openPreview(page)
  await page.route('**/api/documents/*/markdowns/*', route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    return failSave
      ? route.fulfill({ status: 500, json: { detail: 'Save failed' } })
      : route.fallback()
  })
  expect(writes).toEqual([])
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
  await dialog.getByLabel('Enriched content (editable)').fill('# Reviewed correction')
  await dialog.getByRole('button', { name: 'Accept and save', exact: true }).click()
  await expect(page.getByText('Failed to save enriched markdown', { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Enriched content (editable)')).toHaveValue('# Reviewed correction')
  failSave = false
  await dialog.getByRole('button', { name: 'Accept and save', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes).toEqual(['# Reviewed correction', '# Reviewed correction'])
  await expect(page.locator('.markdown-content')).toContainText('Reviewed correction')
})

test('rejecting a correction leaves the saved Markdown unchanged', async ({ page }) => {
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().includes('/markdowns/')) writes.push(request.url())
  })
  const dialog = await openPreview(page)
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes).toEqual([])
  await expect(page.locator('.markdown-content')).not.toContainText('Corrected.')
})

test('many short lines use the editable fallback instead of an unbounded diff matrix', async ({ page }) => {
  const original = '# Document\n' + Array.from({ length: 2000 }, (_, i) => `Line ${i}`).join('\n')
  const enriched = `${original}\nCorrected.`
  const dialog = await openPreview(page, original, enriched)
  await expect(dialog).toContainText('too large to compute a line-by-line diff')
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(dialog.getByLabel('Enriched content (editable)')).toHaveValue(enriched)
})

for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`correction review keeps themed controls and headings aligned at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: theme })
      const dialog = await openPreview(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(dialog.getByRole('button', { name: 'Accept and save' })).toHaveClass(/ui-button--primary/)
      await page.screenshot({ path: testInfo.outputPath('diff.png'), animations: 'disabled' })
      await dialog.getByRole('button', { name: 'Edit', exact: true }).click()
      const originalHeading = await dialog.locator('.enrich-diff-original-heading').boundingBox()
      const enrichedHeading = await dialog.locator('.enrich-diff-enriched-heading').boundingBox()
      const originalEditor = await dialog.getByLabel('Original content (read-only)').boundingBox()
      const enrichedEditor = await dialog.getByLabel('Enriched content (editable)').boundingBox()
      expect(originalHeading && originalEditor && enrichedHeading && enrichedEditor).toBeTruthy()
      expect(originalHeading!.y + originalHeading!.height).toBeLessThanOrEqual(originalEditor!.y + 1)
      expect(enrichedHeading!.y + enrichedHeading!.height).toBeLessThanOrEqual(enrichedEditor!.y + 1)
      if (width < 900) expect(originalEditor!.y + originalEditor!.height).toBeLessThanOrEqual(enrichedHeading!.y + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('edit.png'), animations: 'disabled' })
    })
  }
}
