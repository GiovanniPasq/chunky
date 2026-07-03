import { describe, expect, it } from 'vitest'
import { splitMarkdownSections } from './markdownSections'

describe('splitMarkdownSections', () => {
  it('never cuts a fenced code block at blank lines', () => {
    const markdown = [
      '# Example',
      '',
      '```python',
      'def one():',
      '    return 1',
      '',
      'def two():',
      '    return 2',
      '```',
      '',
      'After the code.',
    ].join('\n')

    const sections = splitMarkdownSections(markdown, 20)
    const codeSection = sections.find(section => section.includes('def one'))

    expect(codeSection).toContain('def two')
    expect(codeSection?.match(/```/g)).toHaveLength(2)
  })

  it('still groups ordinary markdown near the requested size', () => {
    expect(splitMarkdownSections('one\n\ntwo\n\nthree', 8)).toEqual([
      'one\n\ntwo',
      'three',
    ])
  })
})
