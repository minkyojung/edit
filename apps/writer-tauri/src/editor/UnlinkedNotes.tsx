// Fallback list rendered at the bottom of the editor canvas: any
// child note (writing under the active doc) that the user hasn't
// referenced via a wikilink in the body. Surfacing them keeps a
// child from going invisible just because the author hasn't typed
// `[[name]]` yet — the sidebar tree is one place to find children,
// this is the other, anchored to the parent doc itself.
//
// Hidden when there are no children, or when every child is already
// linked from the body. Updates live: PM doc changes via
// usePmDocVersion bump the version and re-collect referenced slugs;
// docsStore changes (new child added, child closed) re-derive
// the children list.
//
// Each row uses the child's live Y.Text title when its handle is
// already open, falling back to "Untitled" otherwise. Clicking a
// row pushes the child back into openSlugs (if not there) and
// activates it, mirroring the wikilink click behavior.

import { useMemo } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { IconFileDescription } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useDocTitle } from '@/hooks/useDocTitle'
import { usePmDocVersion } from '@/hooks/usePmDocVersion'
import { isWikilinkHref, slugFromWikilinkHref } from './wikilinkPalettePlugin'

interface Props {
  view: EditorView | null
  parentSlug: string | null
}

export function UnlinkedNotes({ view, parentSlug }: Props) {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const docVersion = usePmDocVersion()

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, docVersion])

  const children = useMemo(
    () =>
      knownDocs.filter(
        (d) => d.parentId === parentSlug && d.type === 'writing',
      ),
    [knownDocs, parentSlug],
  )

  const unlinked = useMemo(
    () => children.filter((c) => !referenced.has(c.slug)),
    [children, referenced],
  )

  if (unlinked.length === 0) return null

  return (
    <section
      aria-label="Unlinked child notes"
      className="mt-8 border-t border-border pt-4"
    >
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Unlinked notes
      </h3>
      <ul className="flex flex-col gap-0.5">
        {unlinked.map((doc) => (
          <UnlinkedRow key={doc.slug} doc={doc} />
        ))}
      </ul>
    </section>
  )
}

function UnlinkedRow({ doc }: { doc: KnownDoc }) {
  const handle = useDocsStore((s) => s.handles[doc.slug])
  const setActive = useDocsStore((s) => s.setActive)
  const openSlugs = useDocsStore((s) => s.openSlugs)
  const { title } = useDocTitle(handle?.ydoc ?? null)

  const onClick = () => {
    if (!openSlugs.includes(doc.slug)) {
      useDocsStore.setState((s) =>
        s.openSlugs.includes(doc.slug)
          ? s
          : { openSlugs: [...s.openSlugs, doc.slug] },
      )
    }
    setActive(doc.slug)
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
        <span className="truncate">{title || 'Untitled'}</span>
      </button>
    </li>
  )
}
