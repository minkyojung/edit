// The highlight bar — one bottom-center floating surface that morphs
// between states (cmHighlights drives the state machine):
//
//   prompt → a "Highlight ⌘⇧M" pill (text is selected)
//   edit   → the pill becomes a note input + confirm (+ remove for an
//            existing highlight)
//
// Bottom-center so it never occludes the selected text (the old
// selection-following popup did). Only on captured notes (sourceUrl).
// Reuses the save logic the Milkdown path used: setHighlightNote, and
// appendHighlightToDaily on the FIRST note (mirrors the comment into the
// daily). The bar's strong shadow reads it as a floating command surface.

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { IconHighlight, IconCheck, IconTrash } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { setHighlightNote, removeHighlightRecord } from '@/lib/highlights'
import { appendHighlightToDaily } from '@/lib/appendHighlightToDaily'
import { Button } from '@/components/ui/button'
import { FLOATING_MENU_SHELL } from '@/editor/floatingMenuShell'
import { cn } from '@/lib/utils'
import {
  useCmHighlightBar,
  closeHighlightBar,
  createHighlightFromSelection,
} from '@/editor/cmHighlights'

interface Props {
  viewRef: RefObject<EditorView | null>
  slug: string | null
}

export function CmHighlightBar({ viewRef, slug }: Props) {
  const state = useCmHighlightBar((s) => s.state)
  const doc = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) : undefined,
  )
  // Reactive record lookup for the edit state.
  const record = useDocsStore((s) => {
    if (state.kind !== 'edit' || !slug) return undefined
    return s.knownDocs
      .find((d) => d.slug === slug)
      ?.highlights?.find((h) => h.id === state.id)
  })

  // Captured notes only; hidden when idle.
  if (!slug || !doc?.sourceUrl || state.kind === 'idle') return null
  // Editing a record that vanished (deleted elsewhere) → nothing to show.
  if (state.kind === 'edit' && !record) return null

  return (
    // absolute (not fixed) so it centers on the editor pane — CmEditor's
    // relative root — not the whole viewport (which the chat panel offsets).
    <div
      className="absolute left-1/2 z-50 -translate-x-1/2"
      style={{ bottom: 'calc(var(--footer-h) + 1.5rem)' }}
    >
      {/* Brighter than the bare shell: a light ring edge + blur lift it off
          the dark editor background so it actually reads. */}
      <div
        className={cn(
          FLOATING_MENU_SHELL,
          'shadow-2xl shadow-black/60 ring-1 ring-foreground/15 backdrop-blur-xl',
        )}
      >
        {state.kind === 'prompt' ? (
          <PromptButton viewRef={viewRef} slug={slug} from={state.from} to={state.to} />
        ) : record ? (
          <EditRow
            key={record.id}
            slug={slug}
            id={record.id}
            quote={record.quote}
            initialNote={record.note ?? ''}
            hadNote={!!record.note}
            isNew={state.isNew}
            title={doc.title ?? 'Untitled'}
          />
        ) : null}
      </div>
    </div>
  )
}

/** State A: the Highlight pill with its hotkey hint. */
function PromptButton({
  viewRef,
  slug,
  from,
  to,
}: {
  viewRef: RefObject<EditorView | null>
  slug: string
  from: number
  to: number
}) {
  const onHighlight = () => {
    const v = viewRef.current
    if (!v) return
    const id = createHighlightFromSelection(v, slug, from, to)
    if (id) useCmHighlightBar.getState().setState({ kind: 'edit', id, isNew: true })
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      // preventDefault keeps the editor selection alive through the click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onHighlight}
      className="gap-1.5 font-medium"
    >
      <IconHighlight size={15} stroke={2} style={{ color: 'oklch(0.82 0.17 85)' }} />
      Highlight
      <kbd className="ml-0.5 rounded border border-border bg-background/70 px-1 py-px text-[10px] leading-none text-muted-foreground">
        ⌘⇧M
      </kbd>
    </Button>
  )
}

/** State B: the pill as a note input + confirm (+ remove for an existing
 * highlight). */
function EditRow({
  slug,
  id,
  quote,
  initialNote,
  hadNote,
  isNew,
  title,
}: {
  slug: string
  id: string
  quote: string
  initialNote: string
  hadNote: boolean
  isNew: boolean
  title: string
}) {
  const [note, setNote] = useState(initialNote)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [])

  const save = () => {
    const trimmed = note.trim()
    setHighlightNote(slug, id, trimmed)
    // First note on a bare highlight → mirror it into today's daily.
    if (trimmed && !hadNote) void appendHighlightToDaily(title, quote, trimmed)
    closeHighlightBar()
  }

  const remove = () => {
    removeHighlightRecord(slug, id)
    closeHighlightBar()
  }

  return (
    <div className="flex items-center gap-1">
      <IconHighlight
        size={15}
        stroke={2}
        className="shrink-0"
        style={{ color: 'oklch(0.82 0.17 85)' }}
      />
      <input
        ref={inputRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            closeHighlightBar()
          }
        }}
        placeholder="Add a note…"
        className="w-56 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <Button variant="ghost" size="icon-xs" onClick={save} aria-label="Save note">
        <IconCheck size={14} stroke={2} />
      </Button>
      {!isNew && (
        <Button
          variant="ghost"
          size="icon-xs"
          onMouseDown={(e) => e.preventDefault()}
          onClick={remove}
          aria-label="Remove highlight"
          className="text-muted-foreground hover:text-destructive"
        >
          <IconTrash size={13} stroke={2} />
        </Button>
      )}
    </div>
  )
}
