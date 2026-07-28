import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown → clean semantic HTML string, for the clipboard.
//
// Reuses the same react-markdown + remark-gfm pipeline the chat renders
// with (StreamingMarkdown), so there is one markdown→HTML definition in
// the app. But it deliberately omits the chat's component overrides
// (wikilinks, shiki code blocks, mermaid diagrams): those emit
// app-specific markup that is meaningless — or broken — when pasted into
// an external editor. External targets (Substack, Notion, Google Docs,
// CodeMirror/ProseMirror) want plain h1–h6 / ul / ol / li / strong / em
// / a / code / pre / blockquote / table, which is exactly what the bare
// pipeline produces. GFM (tables, strikethrough, task lists) comes from
// remark-gfm.
export function markdownToHtml(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>,
  )
}
