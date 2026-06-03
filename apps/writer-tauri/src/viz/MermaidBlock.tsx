import { useEffect, useState } from 'react'
import type { BundledLanguage } from 'shiki'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { useTheme } from '@/components/theme-provider'
import { resolveFontFamily, resolveTokens } from './resolveTokens'

// Mermaid is heavy (it pulls d3 / dagre / cytoscape). Load it lazily on first
// use and cache the module promise so later blocks reuse the same chunk.
type MermaidApi = (typeof import('mermaid'))['default']
let mermaidPromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

// mermaid.render needs a unique DOM id per call.
let renderSeq = 0

// Map our resolved design tokens onto mermaid's `base` theme slots. This is a
// brand-tone match (slot mapping), not a pixel-perfect clone. Tokens that
// don't resolve are skipped so mermaid keeps its own default for that slot.
function buildThemeVariables(): Record<string, string> {
  const t = resolveTokens([
    '--background',
    '--foreground',
    '--muted',
    '--muted-foreground',
    '--border',
    '--secondary',
    '--accent',
  ])
  const vars: Record<string, string> = {}
  const set = (slot: string, value: string | undefined) => {
    if (value) vars[slot] = value
  }
  set('background', t['--background'])
  set('primaryColor', t['--muted'])
  set('primaryTextColor', t['--foreground'])
  set('primaryBorderColor', t['--border'])
  set('secondaryColor', t['--secondary'])
  set('tertiaryColor', t['--accent'])
  set('lineColor', t['--muted-foreground'])
  set('textColor', t['--foreground'])
  set('mainBkg', t['--muted'])
  set('nodeBorder', t['--border'])
  set('clusterBkg', t['--secondary'])
  set('clusterBorder', t['--border'])
  set('titleColor', t['--foreground'])
  set('edgeLabelBackground', t['--background'])
  vars.fontFamily = resolveFontFamily()
  return vars
}

/** Render a ```mermaid fenced block as an inline diagram. Falls back to the
 * raw source as a code block while streaming, on a parse error, or before the
 * first successful render — the chat must never break on bad AI output. */
export function MermaidBlock({
  code,
  isStreaming,
}: {
  code: string
  isStreaming: boolean
}) {
  const { palette } = useTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    // Only render a completed fence. While the assistant is still streaming
    // tokens the source is half-written and would fail to parse on every
    // keystroke; show the raw source until the block settles. Re-running on
    // `palette` change re-themes the (static) SVG for light/dark switches.
    if (isStreaming) return

    let cancelled = false
    setFailed(false)

    void (async () => {
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({
          startOnLoad: false,
          // strict: sanitises labels (DOMPurify) and disables `click`
          // directives / html labels — closes mermaid's historical XSS surface.
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: buildThemeVariables(),
        })
        const id = `mermaid-${renderSeq++}`
        // Validate first so a syntax error rejects cleanly here instead of
        // leaving a half-built node behind.
        await mermaid.parse(code)
        const { svg: out } = await mermaid.render(id, code)
        if (!cancelled) setSvg(out)
      } catch {
        if (!cancelled) {
          setSvg(null)
          setFailed(true)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, palette, isStreaming])

  if (isStreaming || failed || svg === null) {
    return <CodeBlock code={code} language={'text' as BundledLanguage} />
  }

  return (
    <div
      className="my-2 flex justify-center overflow-x-auto rounded-md border bg-background p-3 [&_svg]:h-auto [&_svg]:max-w-full"
      // mermaid `securityLevel: 'strict'` runs the output through DOMPurify;
      // the app CSP also blocks inline script execution. Safe to inject.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
