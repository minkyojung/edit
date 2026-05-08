// Wiki pages section for the sidebar — belief / entity / episode
// docs and any user-defined wiki pages. Lives below the date-axis
// date view because wiki content is agent-synthesized memory,
// not user-authored notes on the time spine; mixing them blurs the
// write-ownership split (see isWikiDoc in docsStore).

import { useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { IconFileDescription, IconPlus } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useDocsStore, isWikiDoc, type KnownDoc } from '@/state/docsStore'
import { useDocLabel } from '@/hooks/useDocLabel'
import { createCustomWikiPage } from '@/state/wikiService'

export function WikiSection() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const setActive = useDocsStore((s) => s.setActive)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const wikiDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt && isWikiDoc(d)),
    [knownDocs],
  )

  const ensureNotesRoute = () => {
    if (!pathname.startsWith('/notes')) navigate('/notes')
  }

  const handleNew = async () => {
    // Untitled by design: the new doc gets a title input the user
    // fills in immediately. Notion-style — no modal, no prompt, the
    // empty title field IS the prompt. Custom-* slug ensures it
    // never collides with a seed wiki type.
    const slug = await createCustomWikiPage('Untitled')
    if (!slug) return
    setActive(slug)
    ensureNotesRoute()
  }

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[13px] font-medium text-muted-foreground">
          Wiki
        </span>
        <button
          type="button"
          onClick={handleNew}
          aria-label="New wiki page"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <IconPlus size={13} stroke={1.75} />
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {wikiDocs.map((doc) => (
          <li key={doc.slug} data-slug={doc.slug}>
            <WikiRow
              doc={doc}
              isActive={doc.slug === activeSlug}
              onSelect={() => {
                setActive(doc.slug)
                ensureNotesRoute()
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function WikiRow({
  doc,
  isActive,
  onSelect,
}: {
  doc: KnownDoc
  isActive: boolean
  onSelect: () => void
}) {
  const label = useDocLabel(doc.slug)
  // Strip the `wiki:` prefix for a tidy default when the doc has no
  // user-set title yet ("belief" reads better than "wiki:belief").
  const fallback = doc.type.replace(/^wiki:/, '')
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px] font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground"
        aria-hidden
      >
        <IconFileDescription size={12} stroke={1.75} />
      </span>
      <span className="truncate">{label || fallback}</span>
    </button>
  )
}
