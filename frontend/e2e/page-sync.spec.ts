import { expect, test, type Page } from '@playwright/test'
import { mockWorkspace, openDocument, samplePdf } from './fixtures'

const source = [
  '# First page\n\n' + Array(22).fill('First page paragraph with document preparation and source context.').join('\n\n'),
  '# Table page\n\n| Name | Count |\n| --- | --- |\n' + Array.from({ length: 24 }, (_, i) => `| Entry ${i} | ${i} |`).join('\n'),
  '# Last page\n\n' + Array(35).fill('Third page content with a different rendered height from the original PDF.').join('\n\n'),
].map((body, index) => `<!-- page-marker:${index + 1} -->\n${body}`).join('\n\n---\n\n')

async function workspace(page: Page, content = source) {
  await mockWorkspace(page)
  await page.route('**/api/pdf/*', route => route.fulfill({ contentType: 'application/pdf', body: samplePdf([792, 1100, 850]) }))
  await page.route('**/api/document/*', route => route.fulfill({ json: {
    pdf_filename: 'Annual report.pdf', md_filename: 'Annual report_pymupdf4llm.md',
    md_content: content, has_pdf: true, has_markdown: true,
  } }))
  await page.route('**/api/documents/*/markdowns/*', route => route.fulfill({ json: {
    filename: 'Annual report_pymupdf4llm.md', content, source: 'converted', converter: 'pymupdf4llm',
  } }))
  await page.goto('/')
  await openDocument(page)
  await expect(page.getByRole('group', { name: 'PDF page navigation', exact: true })).toContainText('of 3')
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
