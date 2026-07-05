import { useEffect, useMemo, useRef, useState } from 'react'
import type { BundledLanguage } from 'shiki'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { buildArtifactSrcdoc, buildArtifactThemeCss } from './artifactDocument'
import { usePaletteSignal } from './usePaletteSignal'
import { insertVizIntoDoc } from './insertIntoDoc'

// Height clamp. Below MIN avoids a zero-collapse on empty content; above MAX
// stops a runaway artifact from swallowing the whole transcript (it gets an
// internal scrollbar instead, since the iframe content then exceeds its box).
const MIN_HEIGHT = 24
const MAX_HEIGHT = 1600
const INITIAL_HEIGHT = 120
// If no valid height arrives within this window the artifact almost certainly
// failed to run (a script error in the cross-origin frame is invisible to us),
// so we fall back to showing the source.
const RENDER_WATCHDOG_MS = 1500

/** Render an AI-authored ```artifact fenced block as a self-contained HTML
 * document inside an isolated iframe. Mirrors MermaidBlock's lifecycle: only a
 * settled (non-streaming) block renders; while streaming, on failure, or when
 * the user asks, it falls back to the raw source as a code block — the chat
 * must never break. The iframe sandbox (allow-scripts, NO allow-same-origin) is
 * the isolation boundary; see artifactDocument.ts for the injected CSP. */
export function ArtifactBlock({
  code,
  isStreaming,
  embedded = false,
}: {
  code: string
  isStreaming: boolean
  // When rendered inside the editor NodeView, the NodeView owns the
  // edit affordance, so suppress this component's own "Source" toggle.
  embedded?: boolean
}) {
  const themeSignal = usePaletteSignal()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Stable per instance — used to match height messages from OUR frame even
  // when several artifacts share the one window message bus.
  const nonce = useMemo(() => crypto.randomUUID(), [])

  const [height, setHeight] = useState(0)
  const [failed, setFailed] = useState(false)
  const [showSource, setShowSource] = useState(false)

  // Rebuilt only when code / streaming / palette change — a stable reference
  // means React doesn't reassign iframe.srcdoc, so the frame doesn't reload and
  // scripts don't re-run on unrelated parent re-renders. A palette change DOES
  // rebuild (re-themes via reload), matching MermaidBlock's re-render policy.
  const srcDoc = useMemo(() => {
    if (isStreaming) return null
    // buildArtifactThemeCss reads the active palette's tokens from the DOM, so
    // themeSignal is a real (if indirect) dependency — listed to re-theme on switch.
    return buildArtifactSrcdoc({ html: code, nonce, themeCss: buildArtifactThemeCss() })
  }, [code, isStreaming, themeSignal, nonce])

  const showingIframe = srcDoc !== null && !showSource && !failed

  // Height channel. A sandbox frame with no allow-same-origin has an opaque
  // origin → its messages report origin "null" (the string), so we validate
  // against that, never window.origin. nonce + contentWindow identify our frame.
  const gotHeightRef = useRef(false)
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== 'null') return
      const data = e.data as
        | { source?: string; nonce?: string; type?: string; height?: unknown }
        | null
      if (!data || data.source !== 'artifact-frame' || data.type !== 'height') return
      if (data.nonce !== nonce) return
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return
      const h = Number(data.height)
      if (!Number.isFinite(h)) return
      gotHeightRef.current = true
      setFailed(false)
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [nonce])

  // Blank-render watchdog: arm whenever a fresh frame is actually mounted; if no
  // height has arrived in time, treat it as a failed render and show source.
  useEffect(() => {
    if (!showingIframe) return
    gotHeightRef.current = false
    const timer = window.setTimeout(() => {
      if (!gotHeightRef.current) setFailed(true)
    }, RENDER_WATCHDOG_MS)
    return () => window.clearTimeout(timer)
  }, [showingIframe, srcDoc])

  if (!showingIframe) {
    return (
      <div className="my-2">
        {!isStreaming && (failed || showSource) && (
          <div className="mb-1 flex items-center gap-2 text-footnote text-muted-foreground">
            {failed && <span>Couldn’t render the artifact — showing the source.</span>}
            {showSource && !failed && (
              <button
                type="button"
                onClick={() => setShowSource(false)}
                className="rounded px-1.5 py-0.5 hover:bg-muted"
              >
                View render
              </button>
            )}
          </div>
        )}
        <CodeBlock code={code} language={'html' as BundledLanguage} />
      </div>
    )
  }

  return (
    <div
      className={`group relative my-2 overflow-hidden rounded-md${
        embedded ? '' : ' border bg-background'
      }`}
      style={{ contentVisibility: 'auto' }}
    >
      <iframe
        ref={iframeRef}
        title="AI artifact"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="block w-full border-0"
        style={{ height: `${height || INITIAL_HEIGHT}px` }}
      />
      {!embedded && (
        <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => void insertVizIntoDoc('artifact', code)}
            className="rounded bg-background/80 px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-muted"
          >
            Insert into note
          </button>
          <button
            type="button"
            onClick={() => setShowSource(true)}
            className="rounded bg-background/80 px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-muted"
          >
            Source
          </button>
        </div>
      )}
    </div>
  )
}
