import { expect, test, type Page } from '@playwright/test'
import { mockWorkspace, openDocument, samplePdf } from './fixtures'

const source = [
  '# First page\n\n' + Array(22).fill('First page paragraph with document preparation and source context.').join('\n\n'),
  '# Table page\n\n| Name | Count |\n| --- | --- |\n' + Array.from({ length: 24 }, (_, i) => `| Entry ${i} | ${i} |`).join('\n'),
  '# Last page\n\n' + Array(35).fill('Third page content with a different rendered height from the original PDF.').join('\n\n'),
].map((body, index) => `<!-- page-marker:${index + 1} -->\n${body}`).join('\n\n---\n\n')

async function workspace(page: Page, content = source, heights = [792, 1100, 850]) {
  await mockWorkspace(page, 0, content)
  await page.route('**/api/pdf/*', route => route.fulfill({ contentType: 'application/pdf', body: samplePdf(heights) }))
  await page.goto('/')
  await openDocument(page)
  await expect(page.getByRole('group', { name: 'PDF page navigation', exact: true })).toContainText(`of ${heights.length}`)
}

async function pageOffset(page: Page, selector: string, number: number) {
  return page.locator(selector).evaluate((element, n) => {
    const anchor = element.querySelector(`[data-viewer-page="${n}"]`)!
    return element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
  }, number)
}

test('PDF and Markdown page buttons and page input navigate together', async ({ page }) => {
  await workspace(page)
  await page.getByRole('button', { name: 'Next PDF page', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('2')
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('2')
  await expect.poll(() => page.locator('.md-viewer').evaluate(el => Math.abs(el.querySelector('[data-viewer-page="2"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top))).toBeLessThan(3)
  await page.getByRole('button', { name: 'Next Markdown page', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3')
  await page.getByRole('spinbutton', { name: 'PDF page', exact: true }).fill('1')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('1')
})

test('continuous scrolling links source pages and does not produce feedback loops', async ({ page }) => {
  await workspace(page)
  await page.evaluate(() => {
    (window as unknown as { syncEvents: number }).syncEvents = 0
    window.addEventListener('viewer-scroll', () => { (window as unknown as { syncEvents: number }).syncEvents += 1 })
  })
  const top = await pageOffset(page, '.pdf-container', 2)
  await page.locator('.pdf-container').evaluate((el, target) => {
    el.dispatchEvent(new Event('wheel'))
    el.scrollTop = target + 220
  }, top)
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('2')
  await expect.poll(() => page.locator('.md-viewer').evaluate(el => el.scrollTop)).toBeGreaterThan(100)
  await page.waitForTimeout(250)
  expect(await page.evaluate(() => (window as unknown as { syncEvents: number }).syncEvents)).toBeLessThan(8)
  const pdfPage = await page.getByRole('spinbutton', { name: 'PDF page', exact: true }).inputValue()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).last().click()
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue(pdfPage)
})

test('sync can be disabled and unrelated documents cannot navigate the workspace', async ({ page }) => {
  await workspace(page)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('viewer-page-sync', {
    detail: { source: 'markdown', scope: 'Other.pdf', page: 3, force: true },
  })))
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('1')
  await page.getByRole('button', { name: /Page sync/ }).click()
  await page.getByRole('button', { name: 'Next PDF page', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('2')
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('1')
  await page.getByRole('button', { name: 'Page 3', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3')
})

test('older Markdown uses explicitly approximate sync', async ({ page }) => {
  await workspace(page, source.replace(/<!-- page-marker:\d+ -->\n/g, ''))
  await expect(page.getByRole('button', { name: /Approx. sync/ })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Markdown page navigation' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Next PDF page', exact: true }).click()
  await expect.poll(() => page.locator('.md-viewer').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
})


test('legacy page-linking action explains reconversion before replacing saved Markdown', async ({ page }) => {
  await workspace(page, source.replace(/<!-- page-marker:\d+ -->\n/g, ''))
  await page.getByRole('button', { name: 'Link pages…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Enable linked pages', exact: true })
  await expect(dialog).toContainText('Reconversion replaces the saved Markdown')
  await expect(dialog.getByRole('button', { name: 'Reconvert with PyMuPDF', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Markdown page navigation' })).toHaveCount(0)
})

test('page anchors survive content reflow, PDF zoom, and compact layout changes', async ({ page }) => {
  await workspace(page)
  await page.getByRole('spinbutton', { name: 'PDF page', exact: true }).fill('3')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('3')
  await expect.poll(() => page.locator('.md-viewer').evaluate(el => Math.abs(el.querySelector('[data-viewer-page="3"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top))).toBeLessThan(3)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).first().click()
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('3')
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'PDF page', exact: true })).toHaveValue('3')
  await expect.poll(() => page.locator('.pdf-container').evaluate(el => Math.abs(el.querySelector('[data-viewer-page="3"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top))).toBeLessThan(3)
})


test('jumping outside the rendered PDF window paints the requested page', async ({ page }) => {
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  const longSource = Array.from({ length: 9 }, (_, index) => `<!-- page-marker:${index + 1} -->\n# Page ${index + 1}\n\n` + Array(24).fill('Source paragraph for page navigation.').join('\n\n')).join('\n\n---\n\n')
  await workspace(page, longSource, Array(9).fill(792))
  await page.getByRole('spinbutton', { name: 'PDF page', exact: true }).fill('9')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('spinbutton', { name: 'Markdown page', exact: true })).toHaveValue('9')
  const canvas = page.locator('.pdf-page').nth(8).locator('canvas')
  await expect.poll(() => canvas.evaluate(element => {
    if (!element.width || !element.height) return false
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3] > 0 && pixels[index] < 200) return true
    return false
  })).toBe(true)
  expect(failures).toEqual([])
})

test('hides internal page markers in rendered chunks and retains them in the editable source', async ({ page }) => {
  await workspace(page)
  await page.getByRole('button', { name: 'Chunks', exact: true }).click()
  const chunk = page.locator('.chunk-block').first()
  await expect(chunk.locator('.markdown-content')).not.toContainText('page-marker:')
  await expect(chunk.locator('.markdown-content')).toContainText('First page paragraph')
  await chunk.locator('.chunk-edit-btn').click()
  await expect(page.getByRole('textbox', { name: 'Chunk content' })).toHaveValue(source)
})
