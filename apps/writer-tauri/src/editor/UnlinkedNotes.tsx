// Footer trigger + popover surfacing child notes (writing under the
// active doc) that the user hasn't referenced via a wikilink in the
// body. Surfacing them keeps a child from going invisible just
// because the author hasn't typed `[[name]]` yet — the sidebar tree
// is one place to find children, this is the other, anchored to the
// parent doc itself.
//
// Hidden when there are no children, or when every child is already
// linked from the body. Updates live: PM doc changes via
// usePmDocVersion bump the version and re-collect referenced slugs;
// docsStore changes (new child added, child closed) re-derive the
// children list.
//
// Lives inside EditorFooter on the right side. Default state is a
// compact `Unlinked (n) >` button; clicking opens a popover with the
// list. Each row uses the child's live Y.Text title when its handle
// is already open, falling back to "Untitled" otherwise. Clicking a
// row pushes the child back into openSlugs (if not there), activates
// it, and closes the popover.

import { useMemo, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconChevronRight, IconFileDescription } from '@tabler/icons-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { useDocLabel } from '@/hooks/useDocLabel'
import { usePmDocVersion } from '@/hooks/usePmDocVersion'
import { isWikilinkHref, slugFromWikilinkHref } from './wikilinkPalettePlugin'

interface Props {
  view: EditorView | null
  parentSlug: string | null
}

export function UnlinkedNotes({ view, parentSlug }: Props) {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const docVersion = usePmDocVersion()
  const [open, setOpen] = useState(false)

  // Walk the PM doc once per change, collecting note: hrefs from
  // every link mark instance. Cheap (just a descend over text
  // nodes); rebuilding on every doc bump is fine.
  const referenced = useMemo(() => {
    if (!view) return new Set<string>()
    const set = new Set<string>()
    view.state.doc.descendants((node) => {
      if (!node.isText) return
      for (const mark of node.marks) {
        if (mark.type.name !== 'link') continue
        const href = mark.attrs.href as string | undefined
        if (isWikilinkHref(href)) set.add(slugFromWikilinkHref(href!))
      }
    })
    return set
  }, [view, docVersion])

  const children = useMemo(
    () =>
      knownDocs.filter(
        (d) =>
          d.parentId === parentSlug &&
          d.type === 'writing' &&
          !d.archivedAt,
      ),
    [knownDocs, parentSlug],
  )

  const unlinked = useMemo(
    () => children.filter((c) => !referenced.has(c.slug)),
    [children, referenced],
  )

  if (unlinked.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${unlinked.length} unlinked child notes`}
          className={cn(
            'flex items-center gap-1',
            'text-[13px] leading-none text-muted-foreground opacity-80',
            'transition-opacity hover:opacity-100',
            'outline-none focus-visible:opacity-100',
          )}
        >
          <span>Unlinked ({unlinked.length})</span>
          <IconChevronRight size={11} stroke={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-64 gap-0 p-1"
      >
        <ul className="flex flex-col">
          {unlinked.map((doc) => (
            <UnlinkedRow
              key={doc.slug}
              doc={doc}
              onPick={() => setOpen(false)}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function UnlinkedRow({
  doc,
  onPick,
}: {
  doc: KnownDoc
  onPick: () => void
}) {
  const label = useDocLabel(doc.slug)

  const onClick = () => {
    const store = useDocsStore.getState()
    // Push the new view through location.hash so the picked doc
    // shows up in the back/forward stack. useRouteSync mirrors it
    // into the store on the next tick, which runs the setActive
    // path (openSlugs append + ensureHandle).
    window.location.hash = buildViewUrl({
      tab: store.sidebarTab,
      dayAnchor: store.dayAnchor,
      monthAnchor: store.monthAnchor,
      slug: doc.slug,
    })
    onPick()
  }

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
          'outline-none text-foreground/80 hover:bg-accent/40 hover:text-foreground',
          'focus-visible:ring-2 focus-visible:ring-ring/40',
        )}
      >
        <IconFileDescription
          size={12}
          stroke={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate">{label}</span>
      </button>
    </li>
  )
}
