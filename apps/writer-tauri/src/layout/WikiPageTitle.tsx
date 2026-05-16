// Explicit page-title input for user-owned wiki pages.
//
// Sits above the editor body, mirroring the daily-date label position
// in MilkdownEditor. Notion-style: title and body are separate
// surfaces, the title is an explicit field, and renaming the page
// happens here rather than via "first body line magic".
//
// Why this exists:
//   The previous "title is the body's first line" rule conflated
//   two things — the page's name and its content. When ingest wrote
//   bullets into a page named "Michael", the sidebar started reading
//   the first bullet ("Joined as new manager") as the page name.
//   Worse, with proofAuthored marks, the raw mark wrapper leaked
//   into labels. Splitting them apart matches Notion / Obsidian /
//   Linear and unblocks the user-rename UX the sidebar `+` button
//   was meant to provide.
//
// Behavior:
//   - Reads / writes `knownDocs[].title` via setDocTitle.
//   - Empty input commits as cleared title (sidebar shows
//     'Untitled').
//   - Local controlled state so typing feels instant; commits to
//     the store on every change (store is in-memory, no debounce
//     cost). Persistence is handled by the docs catalog's IDB
//     snapshot the same way other doc mutations are.
//   - Only renders for user-owned wiki pages. System pages
//     (system:log / system:conventions / system:index) have fixed
//     labels and aren't user-renameable.

import { useEffect, useState } from 'react'
import { isUserOwnedWiki, useDocsStore } from '@/state/docsStore'

interface Props {
  slug: string
}

export function WikiPageTitle({ slug }: Props) {
  const known = useDocsStore((s) => s.knownDocs.find((d) => d.slug === slug))
  const setDocTitle = useDocsStore((s) => s.setDocTitle)
  const [local, setLocal] = useState(known?.title ?? '')

  // Sync local state when the slug changes (doc switch) or when the
  // stored title changes from outside (e.g. ingest just created the
  // page with an entity name). The check on local !== stored avoids
  // clobbering in-flight typing if the store fires for an unrelated
  // reason.
  useEffect(() => {
    const stored = known?.title ?? ''
    if (stored !== local) setLocal(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, known?.title])

  if (!known || !isUserOwnedWiki(known)) return null

  function handleChange(next: string) {
    setLocal(next)
    setDocTitle(slug, next)
  }

  return (
    <input
      type="text"
      value={local}
      onChange={(e) => handleChange(e.target.value)}
      placeholder="Untitled"
      aria-label="Page title"
      className="mb-6 w-full bg-transparent text-3xl font-semibold leading-tight text-foreground outline-none placeholder:text-muted-foreground/40"
    />
  )
}
