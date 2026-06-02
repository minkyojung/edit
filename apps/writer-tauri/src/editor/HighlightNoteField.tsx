// Shared note field for a highlight — the one place that captures/edits a
// highlight's note. Rendered inside SelectionMenu (below the format row)
// for both flows: writing a note on a just-created highlight, and editing
// one on a highlight you clicked into. Single source of note behavior.
//
// Quote + single-line input; commits once on Enter / blur / Escape. Saving
// the FIRST note on a bare highlight mirrors it into today's daily (it
// becomes a comment); later edits update the record only (the daily is
// append-once). Mount fresh per highlight via `key` so state + focus reset.

import { useEffect, useRef, useState } from 'react'
import { setHighlightNote } from '@/lib/highlights'
import { appendHighlightToDaily } from '@/lib/appendHighlightToDaily'

export function HighlightNoteField({
  slug,
  id,
  quote,
  initialNote,
  hadNote,
  title,
  onClose,
}: {
  slug: string
  id: string
  quote: string
  initialNote: string
  /** Whether the record already had a note — gates the daily mirror so it
   * fires only on the first note, not on later edits. */
  hadNote: boolean
  /** Article title, for the daily-note line. */
  title: string
  onClose: () => void
}) {
  const [note, setNote] = useState(initialNote)
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])

  // Commit-once: Enter / blur save, Escape skips. A single guard makes every
  // terminal path run exactly once.
  const commit = (save: boolean) => {
    if (committedRef.current) return
    committedRef.current = true
    if (save) {
      const trimmed = note.trim()
      setHighlightNote(slug, id, trimmed)
      // Bare highlight → comment: mirror to the daily only on the first note.
      if (trimmed && !hadNote) void appendHighlightToDaily(title, quote, trimmed)
    }
    onClose()
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="truncate px-1.5 pt-0.5 text-xs text-muted-foreground">
        “{quote}”
      </div>
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
        onBlur={() => commit(true)}
        placeholder="Add a note…"
        className="w-full rounded-lg bg-transparent px-1.5 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
