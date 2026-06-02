// Inline note input shown right after a highlight is created. Type a note
// and it becomes a COMMENT: the note saves on the record and a bullet is
// mirrored into today's daily (`- "quote" — note`). Skip (no note) and it
// stays a bare highlight — the amber mark in the article only, nothing in
// the daily. Committed exactly once on Enter / blur / Escape.

import { useEffect, useRef, useState } from 'react'
import { useHighlightNoteStore } from '@/state/highlightNoteStore'
import { setHighlightNote } from '@/lib/highlights'
import { appendHighlightToDaily } from '@/lib/appendHighlightToDaily'

export function HighlightNotePopover() {
  const open = useHighlightNoteStore((s) => s.open)
  const slug = useHighlightNoteStore((s) => s.slug)
  const id = useHighlightNoteStore((s) => s.id)
  const quote = useHighlightNoteStore((s) => s.quote)
  const title = useHighlightNoteStore((s) => s.title)
  const anchor = useHighlightNoteStore((s) => s.anchor)
  const close = useHighlightNoteStore((s) => s.close)

  const [note, setNote] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards the single commit — Enter then blur (or Escape then blur)
  // must not append the daily line twice.
  const committedRef = useRef(false)

  // Fresh state + focus each time a new highlight opens the popover.
  useEffect(() => {
    if (!open) return
    setNote('')
    committedRef.current = false
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, id])

  if (!open || !slug || !id || !title || !anchor) return null

  /** Write the note (if any) to the record and mirror the highlight into
   * today's daily — once. `save=false` (Escape) means quote-only. */
  const commit = (save: boolean) => {
    if (committedRef.current) return
    committedRef.current = true
    const finalNote = save ? note.trim() : ''
    // Only COMMENTED highlights flow to the daily — a note is your own
    // thought, journal-worthy. A bare highlight (no note) stays in the
    // article as the amber mark; the daily breadcrumb already records
    // that you read the piece today. This keeps the daily all-your-voice
    // (nothing to visually distinguish) instead of a pile of bare quotes.
    if (finalNote) {
      setHighlightNote(slug, id, finalNote)
      void appendHighlightToDaily(title, quote ?? '', finalNote)
    }
    close()
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
        zIndex: 50,
      }}
      className="w-72 rounded-xl bg-popover/95 p-2 shadow-xl shadow-black/30 ring-1 ring-border backdrop-blur-xl"
    >
      <input
        ref={inputRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            commit(false)
          }
        }}
        // Click-away dismissal: keep whatever was typed.
        onBlur={() => commit(true)}
        placeholder="Add a note… (Enter to save, Esc to skip)"
        className="w-full bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
