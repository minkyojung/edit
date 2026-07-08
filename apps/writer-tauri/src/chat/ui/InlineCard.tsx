import type React from 'react'
import { cn } from '@/lib/utils'

/** Shared container for the small inline cards that show inside an
 * assistant turn — tool calls, thinking, propose_change, plus the
 * stopped / error wrappers around the whole turn body. Single
 * border / radius / background pattern so the chat surface reads as
 * one family instead of seven near-identical custom divs. */
export function InlineCard({
  tone = 'default',
  className,
  children,
}: {
  tone?: 'default' | 'destructive'
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border',
        tone === 'destructive'
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-border/60 bg-muted/60',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Footer row for InlineCard — used by stopped / error wrappers. The
 * tone follows the parent card so destructive cards keep the red
 * gradient through to the action row. */
export function InlineCardFooter({
  tone = 'default',
  className,
  children,
}: {
  tone?: 'default' | 'destructive'
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 border-t px-3 py-1.5 text-footnote',
        tone === 'destructive'
          ? 'border-destructive/30 bg-destructive/15 text-destructive'
          : 'border-border/60 bg-muted/70 text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}
