// Floating autocomplete that opens on `[[` inside the editor body.
// Wraps the plugin's emitted state into a popup positioned at the
// caret. Resolves the typed query against the current doc's
// children — both the prebuilt KnownDoc cache (so closed siblings
// still appear) and the cached knownDocs.title.
//
// Path C Step 4: titles are filenames, decoupled from body. The
// palette displays whatever name the user gave each doc via the
// inline title input / Command Palette Rename — never live body
// content.
//
// Behavior matches SlashPalette: keyboard-only navigation
// (ArrowUp/Down/Tab/Enter/Escape) with mouse fallback. Clicking
// commits via mousedown so the editor's contenteditable doesn't
// lose focus before the insert dispatches.

import { useEffect, useMemo, useState } from 'react'
import {
  cancelWikilink,
  commitWikilink,
  type WikilinkPaletteInfo,
  type WikilinkPaletteKey,
} from './wikilinkPalettePlugin'
import { useDocsStore, isUserOwnedWiki, type KnownDoc } from '@/state/docsStore'
import { getActiveSlugFromHash } from '@/lib/viewUrl'
import { cn } from '@/lib/utils'
import { notify } from '@/lib/notify'

interface Props {
  /** Current doc whose children become the candidate set for the
   * palette. `null` while the editor doesn't have a handle yet. */
  parentSlug: string | null
  /** Imperative bridge from the plugin's onKey callback so the popup
   * can drive its own selection without ProseMirror swallowing
   * up/down/enter. Caller should mutate this ref's `.current`
   * whenever the popup mounts/unmounts. */
  keyHandlerRef: React.MutableRefObject<((key: WikilinkPaletteKey) => boolean) | null>
}

interface Candidate {
  kind: 'existing' | 'create'
  label: string
  slug?: string
}

export function WikilinkPalette({ parentSlug, keyHandlerRef }: Props) {
  const [info, setInfo] = useState<WikilinkPaletteInfo | null>(null)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // The plugin emits via a window-level event since we don't want to
  // drag a callback prop through every Milkdown user. The plugin
  // factory in MilkdownEditor wires the bridge so we just listen.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<WikilinkPaletteInfo | null>).detail
      setInfo(detail ?? null)
      setSelectedIndex(0)
    }
    window.addEventListener('writer:wikilink-palette', handler as EventListener)
    return () =>
      window.removeEventListener(
        'writer:wikilink-palette',
        handler as EventListener,
      )
  }, [])

  const findDailyAncestorSlug = useDocsStore((s) => s.findDailyAncestorSlug)
  // Anchor every palette interaction (candidate filter + create) on
  // the daily ancestor. Writings nest only 1-deep under a daily, so
  // resolving here means a [[link]] typed from inside a writing sees
  // its siblings under the same daily — and any new doc lands as a
  // sibling, not a (forbidden) grandchild. When the active doc is
  // itself a daily this resolves to its own slug.
  const dailySlug = parentSlug ? findDailyAncestorSlug(parentSlug) : null

  const candidates = useMemo<Candidate[]>(() => {
    if (!info || !dailySlug) return []
    const q = info.query.trim().toLowerCase()
    // Two candidate pools, unioned:
    //   1. Writings nested under this daily (parentId === dailySlug)
    //   2. User-owned wiki pages (flat — no parentId since the
    //      Karpathy refactor). isUserOwnedWiki narrows to wiki:custom-*
    //      so system pages (system:index / system:log / conventions)
    //      stay out — they have their own surfaces and aren't valid
    //      link targets.
    const children = knownDocs.filter(
      (d) =>
        !d.archivedAt &&
        (d.parentId === dailySlug || isUserOwnedWiki(d)),
    )
    const matches = children
      .map((doc) => ({ doc, title: titleFor(doc) }))
      .filter(({ title }) => !q || title.toLowerCase().includes(q))
      .slice(0, 8)
      .map(({ doc, title }) => ({
        kind: 'existing' as const,
        label: title,
        slug: doc.slug,
      }))

    const exact = matches.find((m) => m.label.toLowerCase() === q)
    const create: Candidate[] =
      q && !exact
        ? [{ kind: 'create', label: info.query.trim() || 'Untitled' }]
        : []
    return [...matches, ...create]
  }, [info, dailySlug, knownDocs])

  // Clamp selectedIndex when the candidate list shrinks.
  const safeIndex = candidates.length === 0
    ? 0
    : Math.min(selectedIndex, candidates.length - 1)

  // Wire the imperative key bridge — installed while the popup is
  // mounted, removed on unmount. Returning `true` tells the plugin
  // to swallow the event.
  useEffect(() => {
    keyHandlerRef.current = (key) => {
      if (!info) return false
      if (key === 'Escape') {
        cancelWikilink(info.view)
        return true
      }
      if (key === 'ArrowDown') {
        setSelectedIndex((i) =>
          candidates.length === 0 ? 0 : (i + 1) % candidates.length,
        )
        return true
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((i) =>
          candidates.length === 0
            ? 0
            : (i - 1 + candidates.length) % candidates.length,
        )
        return true
      }
      if (key === 'Enter' || key === 'Tab') {
        if (candidates.length === 0) return false
        const pick = candidates[safeIndex]
        commit(info, pick).catch((err) => {
          console.error('[wikilink] commit failed', err)
          notify.wikilinkCreateFailed()
        })
        return true
      }
      return false
    }
    return () => {
      keyHandlerRef.current = null
    }
  }, [info, candidates, safeIndex, keyHandlerRef])

  if (!info || !dailySlug) return null

  // Position popup just below the caret. Use viewport coords from
  // the plugin's coordsAtPos and offset by 2px so it doesn't kiss
  // the caret line.
  const style: React.CSSProperties = {
    position: 'fixed',
    left: info.rect.left,
    top: info.rect.bottom + 4,
    zIndex: 'var(--z-popover)',
    minWidth: '14rem',
    maxWidth: '20rem',
  }

  return (
    <div
      style={style}
      role="listbox"
      aria-label="Wikilink suggestions"
      className={cn(
        'rounded-xl border border-border bg-popover p-1 shadow-md',
        'text-popover-foreground',
      )}
    >
      {candidates.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Keep typing to create…
        </div>
      ) : (
        candidates.map((cand, i) => (
          <button
            key={`${cand.kind}:${cand.slug ?? cand.label}:${i}`}
            type="button"
            data-selected={i === safeIndex || undefined}
            onMouseDown={(e) => {
              // mousedown so editor focus is preserved when we
              // dispatch the insert.
              e.preventDefault()
              commit(info, cand).catch((err) => {
                console.error('[wikilink] commit failed', err)
                notify.wikilinkCreateFailed()
              })
            }}
            onMouseEnter={() => setSelectedIndex(i)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors',
              i === safeIndex ? 'bg-accent text-foreground' : 'hover:bg-muted/50',
            )}
          >
            {cand.kind === 'create' ? (
              <>
                <span className="text-muted-foreground">＋</span>
                <span className="truncate">
                  Create <span className="font-medium">{cand.label}</span>
                </span>
              </>
            ) : (
              <span className="truncate">{cand.label}</span>
            )}
          </button>
        ))
      )}
    </div>
  )
}

/** Resolve the user's pick into an actual wikilink insert. For an
 * existing match we just splice the node in; for a "Create" pick we
 * spin up a new child note (via proofClient + docsStore) before
 * committing. Errors fall back to a Cancel so the editor doesn't
 * end up with a partial `[[query` literal. */
async function commit(info: WikilinkPaletteInfo, pick: Candidate) {
  if (pick.kind === 'existing' && pick.slug) {
    commitWikilink(info.view, { from: info.from, to: info.to }, pick.slug, pick.label)
    return
  }
  if (pick.kind === 'create') {
    const store = useDocsStore.getState()
    const activeSlug = getActiveSlugFromHash()
    if (!activeSlug) {
      cancelWikilink(info.view)
      return
    }
    // Resolve to the active doc's daily ancestor — writings nest only
    // 1-deep under a daily, so a [[link]] typed from inside a writing
    // creates a sibling under the same daily rather than a (forbidden)
    // grandchild. When the active doc is itself a daily this is a no-op.
    const dailyParent = store.findDailyAncestorSlug(activeSlug)
    if (!dailyParent) {
      cancelWikilink(info.view)
      return
    }
    // Goes through the store action so the title field gets seeded
    // and the handle is warmed; otherwise sidebar / tab labels
    // would render "Untitled" until the user opened the child.
    const slug = await store.createWritingChild(dailyParent, pick.label)
    if (!slug) {
      cancelWikilink(info.view)
      return
    }
    commitWikilink(
      info.view,
      { from: info.from, to: info.to },
      slug,
      pick.label,
    )
  }
}

/** Display label for a candidate row. Path C Step 4: title is
 * decoupled from body — the filename (knownDocs.title) is the only
 * source. Body edits do not affect the palette label. */
function titleFor(doc: KnownDoc): string {
  return doc.title?.trim() || 'Untitled'
}
