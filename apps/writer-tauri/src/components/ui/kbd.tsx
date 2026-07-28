import type { ReactNode } from 'react'

/** Inline keyboard glyph used in tooltips. The tooltip CSS auto-styles
 * anything with `data-slot="kbd"` (rounded corners, inset shadow); we just
 * supply the muted text + monospace layer. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      data-slot="kbd"
      className="bg-foreground/10 text-foreground/80 font-mono text-footnote leading-none px-1 py-0.5"
    >
      {children}
    </kbd>
  )
}
