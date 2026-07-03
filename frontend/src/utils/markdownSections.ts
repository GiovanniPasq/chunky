/**
 * Split Markdown into renderable sections without cutting fenced code blocks.
 *
 * Blank lines remain the preferred boundary, but a blank line inside a
 * backtick/tilde fence stays inside the same block. Oversized protected blocks
 * remain whole instead of being turned into invalid standalone Markdown.
 */
export function splitMarkdownSections(markdown: string, targetChars: number): string[] {
  const blocks: string[] = []
  let blockLines: string[] = []
  let fence: { char: '`' | '~'; length: number } | null = null

  const flushBlock = () => {
    if (blockLines.length === 0) return
    blocks.push(blockLines.join('\n'))
    blockLines = []
  }

  for (const line of markdown.split('\n')) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const char = marker[0] as '`' | '~'
      if (fence === null) {
        fence = { char, length: marker.length }
      } else if (fence.char === char && marker.length >= fence.length) {
        fence = null
      }
    }

    if (line.trim() === '' && fence === null) {
      flushBlock()
      continue
    }
    blockLines.push(line)
  }
  flushBlock()

  const sections: string[] = []
  let current = ''
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > targetChars) {
      sections.push(current)
      current = block
    } else {
      current = current ? `${current}\n\n${block}` : block
    }
  }
  if (current) sections.push(current)
  return sections.length > 0 ? sections : [markdown]
}
