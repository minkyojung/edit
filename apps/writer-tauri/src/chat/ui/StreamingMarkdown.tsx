import type React from 'react'
import { Streamdown } from 'streamdown'

// Streamdown renders raw markdown progressively (handles incomplete blocks
// during streaming) and memoizes per-block, so we don't need to gate
// markdown rendering on stream-vs-done. The component overrides below align
// inline element styling with the rest of the chat surface.
const markdownComponents: React.ComponentProps<typeof Streamdown>['components'] = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  ),
}

// Streamdown's documented streaming pattern: pass content straight through,
// let it word-wrap each new chunk in animated spans, and rely on blur+opacity
// duration to mask token-arrival bursts (no client-side throttling needed).
// `isAnimating` toggles the animation rehype pass off entirely once the
// stream settles, so finished messages render with no leftover span markup.
const STREAM_ANIMATE = {
  animation: 'blurIn' as const,
  duration: 200,
  sep: 'word' as const,
}

export function StreamingMarkdown({
  content,
  isStreaming,
}: {
  content: string
  isStreaming: boolean
}) {
  return (
    <div className="leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Streamdown
        animated={STREAM_ANIMATE}
        isAnimating={isStreaming}
        components={markdownComponents}
      >
        {content}
      </Streamdown>
    </div>
  )
}
