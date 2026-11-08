import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
}

function hidePageMarkers() {
  const visit = (node: MarkdownNode) => {
    if (!node.children) return
    node.children = node.children.filter(child => !(
      child.type === 'html' && /^<!--\s*page-marker:\d+\s*-->$/.test(child.value?.trim() ?? '')
    ))
    node.children.forEach(visit)
  }
  return visit
}

const plugins = [remarkGfm, hidePageMarkers]

/** Render document Markdown consistently, hiding viewer metadata comments. */
export default function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={plugins}>{children}</ReactMarkdown>
}
