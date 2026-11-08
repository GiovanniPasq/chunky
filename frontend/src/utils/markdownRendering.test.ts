import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MarkdownContent from '../components/common/MarkdownContent'

const render = (source: string) => renderToStaticMarkup(createElement(MarkdownContent, { children: source }))

describe('document Markdown rendering', () => {
  it('hides source page comments and preserves surrounding content and tables', () => {
    const html = render('<!-- page-marker:2 -->\n# Body\n\nText.\n\n<!-- page-marker:3 -->\n\n| Name | Value |\n| --- | --- |\n| Total | 42 |')
    expect(html).not.toContain('page-marker:')
    expect(html).toContain('<h1>Body</h1>')
    expect(html).toContain('<p>Text.</p>')
    expect(html).toContain('<td>42</td>')
  })

  it('keeps page-marker examples inside code fences and inline code visible', () => {
    const html = render('```html\n<!-- page-marker:2 -->\n```\n\nExample: `<!-- page-marker:3 -->`.')
    expect(html).toContain('&lt;!-- page-marker:2 --&gt;')
    expect(html).toContain('&lt;!-- page-marker:3 --&gt;')
  })

  it('keeps escaping other HTML and does not execute it', () => {
    const html = render('<script>alert("test")</script>\n\n<table><tr><td>Original content</td></tr></table>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<table>')
    expect(html).toContain('Original content')
    expect(html).toContain('&lt;script&gt;')
  })
})
