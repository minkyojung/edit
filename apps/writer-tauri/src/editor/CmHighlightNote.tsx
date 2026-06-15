// Note / remove card for a clicked CodeMirror highlight.
//
// Opens beneath the highlight the user clicked (cmHighlights publishes the
// active id + anchor). Reuses HighlightNoteField verbatim — it's view-free
// (only setHighlightNote + appendHighlightToDaily), so the same component
// that served Milkdown serves CM: a note saved on a bare highlight mirrors
// into today's daily. Adds a Remove action below it.

import { IconTrash } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { removeHighlightRecord } from '@/lib/highlights'
import { Button } from '@/components/ui/button'
import { FLOATING_MENU_SHELL } from '@/editor/floatingMenuShell'
import { cn } from '@/lib/utils'
import { HighlightNoteField } from '@/editor/HighlightNoteField'
import { useCmActiveHighlight } from '@/editor/cmHighlights'

export function CmHighlightNote({ slug }: { slug: string | null }) {
  const active = useCmActiveHighlight((s) => s.active)
  // Reactive lookup of the clicked record + its doc title.
  const doc = useDocsStore((s) =>
    slug ? s.knownDocs.find((d) => d.slug === slug) : undefined,
  )
  const record = active
    ? doc?.highlights?.find((h) => h.id === active.id)
    : undefined

  if (!active || !slug || !record) return null

  // Guarded close: only clear if THIS highlight is still the active one, so
  // a blur-commit firing as the user clicks a different highlight doesn't
  // clobber the newer selection.
  const close = () => {
    if (useCmActiveHighlight.getState().active?.id === record.id) {
      useCmActiveHighlight.getState().setActive(null)
    }
  }

  return (
    <div
      className={cn(
        FLOATING_MENU_SHELL,
        'fixed z-50 flex w-72 -translate-x-1/2 flex-col gap-3',
      )}
      style={{ left: active.left, top: active.top + 6 }}
    >
      <HighlightNoteField
        key={record.id}
        slug={slug}
        id={record.id}
        quote={record.quote}
        initialNote={record.note ?? ''}
        hadNote={!!record.note}
        title={doc?.title ?? 'Untitled'}
        autoFocus
        onClose={close}
      />
      <Button
        variant="ghost"
        size="xs"
        // preventDefault so the note input doesn't blur-commit before this
        // runs (we're deleting the record anyway).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          removeHighlightRecord(slug, record.id)
          close()
        }}
        className="self-start text-muted-foreground hover:text-destructive"
      >
        <IconTrash size={13} stroke={2} />
        Remove highlight
      </Button>
    </div>
  )
}
