import type React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BundledLanguage } from 'shiki'
import { remarkWikilink } from './remarkWikilink'
import { WikiLink } from './WikiLink'
import { CodeBlock } from '@/components/ai-elements/code-block'

// Why react-markdown directly (no streamdown, no sanitize):
//
//   - streamdown's default rehype chain (rehype-harden + rehype-sanitize)
//     mangled our `[[Title]]` citations: harden rewrote anchors with
//     unknown URL schemes into a `[blocked]` indicator span, and sanitize
//     dropped `<wikilink>` elements outright with their children.
//
//   - We replaced our custom element with `<a data-wikilink-*>` (standard
//     element + data attribute marker) and switched to react-markdown,
//     but sanitize then stripped the `data-wikilink-*` attributes
//     themselves — its schema's attribute allowlist couldn't be extended
//     in a way that survived hast's attribute-name normalisation.
//
//   - react-markdown's baseline behaviour is already XSS-safe: raw
//     `<script>` / `<iframe>` / etc. in markdown are rendered as text,
//     not executed. Our input is assistant text from Anthropic
//     (trusted) routed through a markdown parser; a separate sanitize
//     pass is belt-and-suspenders we don't need here. Dropping it
//     keeps the `data-wikilink-*` markers intact so `components.a`
//     can branch on them.

const REMARK_PLUGINS = [remarkWikilink, remarkGfm]

// Languages shiki ships in its bundled set. We only allowlist names
// the model commonly emits in code fences; anything else falls back
// to plaintext (`text`) instead of throwing inside shiki. Reviewers
// adding new common languages can append below.
const KNOWN_LANGUAGES = new Set<string>([
  'text',
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'sh',
  'shell',
  'zsh',
  'python',
  'py',
  'go',
  'rust',
  'rs',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'rb',
  'sql',
  'html',
  'css',
  'scss',
  'yaml',
  'yml',
  'toml',
  'md',
  'markdown',
  'diff',
  'dockerfile',
  'cpp',
  'c',
  'csharp',
  'cs',
  'php',
])

function normaliseLanguage(raw: string | undefined): BundledLanguage {
  const v = (raw ?? '').toLowerCase()
  if (KNOWN_LANGUAGES.has(v)) return v as BundledLanguage
  return 'text' as BundledLanguage
}

/** Extract a flat text value from the inner code node of a `<pre>`
 * element. react-markdown passes the parsed hast node alongside the
 * rendered children; using the node is the simplest way to recover
 * the raw code string (the React children tree is harder to walk
 * because it's already been turned into React elements). */
function extractCodeText(node: unknown): { code: string; lang: BundledLanguage } {
  // hast `pre` element should have a single `code` child.
  const preNode = node as {
    children?: Array<{
      type?: string
      tagName?: string
      properties?: { className?: string[] | string }
      children?: Array<{ type?: string; value?: string }>
    }>
  }
  const codeNode = preNode?.children?.find((c) => c?.tagName === 'code')
  if (!codeNode) return { code: '', lang: 'text' as BundledLanguage }
  const classNames = Array.isArray(codeNode.properties?.className)
    ? codeNode.properties.className
    : typeof codeNode.properties?.className === 'string'
      ? [codeNode.properties.className]
      : []
  const langClass = classNames.find((c) => c.startsWith('language-'))
  const lang = langClass ? langClass.slice('language-'.length) : ''
  const text =
    codeNode.children
      ?.filter((c) => c?.type === 'text')
      .map((c) => c.value ?? '')
      .join('') ?? ''
  return { code: text, lang: normaliseLanguage(lang) }
}

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p className="leading-snug">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  ),
  // Fenced code blocks. react-markdown nests <code> inside <pre>;
  // overriding <pre> hands us the wrapper to swap in the in-house
  // CodeBlock component (Shiki-backed syntax highlighting, themed
  // via --shiki-* tokens already configured in index.css).
  pre: (props) => {
    const { node } = props as { node?: unknown }
    const { code, lang } = extractCodeText(node)
    return <CodeBlock code={code} language={lang} />
  },
  a: (props) => {
    // react-markdown passes the raw mdast node as `node` on the
    // component props; strip it before spreading onto the DOM so we
    // don't end up with a literal `node="[object Object]"` attribute
    // on the rendered element. Also pull `href` / `children` so
    // they're routed to the right slot.
    const { node: _node, href, children, ...rest } =
      props as React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode
        node?: unknown
      }
    // remarkWikilink stamps every wikilink anchor with this attribute,
    // including broken ones (the broken flag rides in
    // data-wikilink-broken). Presence of the slug attribute — even
    // empty — is the runtime signal that this <a> came from a
    // `[[Title]]` token, not from a real markdown link.
    if ((rest as Record<string, unknown>)['data-wikilink-slug'] !== undefined) {
      return (
        <WikiLink {...(rest as React.ComponentProps<typeof WikiLink>)}>
          {children}
        </WikiLink>
      )
    }
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground"
      >
        {children}
      </a>
    )
  },
}

export function StreamingMarkdown({
  content,
  // isStreaming is kept on the prop API for symmetry with the prior
  // streamdown-based version; react-markdown doesn't need the hint
  // (each content change re-renders from scratch). Future streaming
  // UX (e.g. word-by-word fade) can read this flag again without
  // changing every caller.
  isStreaming: _isStreaming,
}: {
  content: string
  isStreaming: boolean
}) {
  return (
    // `prose` taps the @tailwindcss/typography plugin (configured in
    // index.css to use our design tokens). It handles h1–h6, ul/ol/li,
    // blockquote, hr, table — the things our per-element components
    // map doesn't override. `prose-sm` keeps the scale aligned with
    // the chat surface; `dark:prose-invert` flips to the dark token
    // set when the app is in dark mode; `max-w-none` lets the surface
    // size respect the chat panel's resizable width.
    <div className="prose dark:prose-invert max-w-none text-[15px] leading-snug [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
