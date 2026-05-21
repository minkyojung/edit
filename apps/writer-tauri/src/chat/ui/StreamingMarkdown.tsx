import type React from 'react'
import ReactMarkdown from 'react-markdown'
import { remarkWikilink } from './remarkWikilink'
import { WikiLink } from './WikiLink'

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

const REMARK_PLUGINS = [remarkWikilink]

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  ),
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
    <div className="leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
