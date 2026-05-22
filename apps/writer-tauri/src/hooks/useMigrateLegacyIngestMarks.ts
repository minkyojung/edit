// One-shot migration for the wiki-ingest-banner-inbox refactor
// (2026-05-13). Before this change, ingest proposals were stamped
// as proofSuggestion marks on the last word of the target wiki
// page, with the content riding in Y.Map('marks'). The banner
// surface (WikiPageBanner.tsx) replaces that — proposals now live
// only in ingestStore until accept, and on accept they become
// proofAuthored marks on actually-inserted content.
//
// Existing user databases may still carry the legacy marks. On a
// fresh boot, the first time the user opens each wiki page, this
// hook scans the PM doc for proofSuggestion marks whose Y.Map
// metadata has by='ai:wiki-ingest' and strips them (both the inline
// mark and the Y.Map entry). The matching ingestStore queue entries
// have already been removed at original stamp time, so there's no
// re-enqueue to do — the user simply loses those stale pending
// proposals. Next ingest pass regenerates current ones.
//
// Idempotent: a page with no legacy marks is a cheap descendants
// scan with no writes. Tracks completion per slug via a ref so the
// scan doesn't re-fire on every render.

import { useEffect, useRef } from 'react'
import { useDocsStore, isWikiDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { useEditorViewStore } from '@/state/editorViewStore'
import type { StoredMark } from '@/hooks/useCollabDoc'

const AGENT_ID = 'ai:wiki-ingest'

export function useMigrateLegacyIngestMarks(): void {
  const activeSlug = useActiveSlug()
  const handles = useDocsStore((s) => s.handles)
  const view = useEditorViewStore((s) => s.view)
  const sweptRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!activeSlug || !view) return
    if (sweptRef.current.has(activeSlug)) return
    const known = useDocsStore
      .getState()
      .knownDocs.find((d) => d.slug === activeSlug)
    if (!known || !isWikiDoc(known)) return
    const handle = handles[activeSlug]
    if (!handle) return

    // Wait one tick so y-prosemirror has projected the hydrated
    // Y.Doc into PM. Without this, the descendants() scan may run
    // against an empty PM doc immediately post-mount and miss the
    // very marks we're trying to clear. The hook then never retries
    // for this slug (sweptRef latched), and the marks linger.
    const timer = setTimeout(() => {
      const liveView = useEditorViewStore.getState().view
      if (!liveView) return
      const ydoc = handle.ydoc
      const marksMap = ydoc.getMap<StoredMark>('marks')

      // Find every proofSuggestion mark whose Y.Map entry tags it
      // as an ingest-origin mark. Collect ids + ranges first, then
      // mutate in one transaction — concurrent mutation during
      // descendants() iteration would invalidate the traversal.
      const targets: { id: string; from: number; to: number }[] = []
      liveView.state.doc.descendants((node, pos) => {
        if (!node.isText) return
        for (const m of node.marks) {
          if (m.type.name !== 'proofSuggestion') continue
          const id = m.attrs.id
          if (typeof id !== 'string') continue
          const stored = marksMap.get(id)
          if (stored?.by !== AGENT_ID) continue
          targets.push({ id, from: pos, to: pos + node.nodeSize })
        }
      })

      if (targets.length === 0) {
        sweptRef.current.add(activeSlug)
        return
      }

      const suggestionType = liveView.state.schema.marks.proofSuggestion
      if (!suggestionType) {
        sweptRef.current.add(activeSlug)
        return
      }

      ydoc.transact(() => {
        let tr = liveView.state.tr
        for (const t of targets) {
          tr = tr.removeMark(t.from, t.to, suggestionType)
        }
        liveView.dispatch(tr)
        for (const t of targets) {
          marksMap.delete(t.id)
        }
      }, 'mark-action')

      console.log(
        `[ingest:migrate] cleared ${targets.length} legacy ingest mark(s) from`,
        activeSlug,
      )
      sweptRef.current.add(activeSlug)
    }, 200)

    return () => clearTimeout(timer)
  }, [activeSlug, view, handles])
}
