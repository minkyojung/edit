// The single owner of `handle.bodyMarkdown`.
//
// Every write to a doc's in-memory body funnels through here — either
// `updateDocBody` (a read-modify-write transform) or `setBodyMirror` (pure
// construction / editor→mirror caching). Nothing else may assign the mirror,
// so the read-modify-write is atomic and can never be driven from an
// uncoordinated site that forgets to await hydration, serialize, or mark the
// doc dirty. That "forgot one of the four" pattern is exactly what caused the
// past silent-save-loss incidents.
//
// The shape follows the canonical single-writer editors:
//   - Obsidian `Vault.process(file, syncFn)` — atomic read-modify-write with a
//     SYNCHRONOUS transform; async prep happens before the lock.
//   - VS Code `applyEdit` — a write that can't safely land reports failure
//     instead of clobbering (here: the conflict gate returns `ok:false`).
//   - CodeMirror — while an editor is mounted, its own state is the
//     authoritative body; external code pulls from it, never mirror-and-hopes.
//   - Redux/zustand — model writes as commands, not scattered setters; a
//     non-reactive field like this one may be mutated transiently, but the
//     atomicity burden is on the owner, which this module supplies.

import type { CollabHandle } from '@/hooks/useCollabDoc'
import { runExclusive } from '@/lib/keyedMutex'
import { clearDirty, markSlugDirty } from '@/lib/docFileSync'
import { hasExternalConflict } from '@/state/externalConflictStore'
import {
  applyMarkdownToActiveCmEditor,
  pullActiveCmBody,
} from '@/state/activeCmEditor'
import { useDocsStore } from '@/state/docsStore'

export type UpdateDocBodyResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'no-handle' | 'hydrate-failed' | 'conflict' }

export interface UpdateDocBodyOpts {
  /** Tag the CodeMirror transaction so a later Cmd-Z reopens this change
   * (AI-accept path). */
  changeId?: string
  /** Dirty semantics. `'external'` clears the dirty flag (the write reflects
   * disk, e.g. a watcher reload); everything else marks the slug dirty so the
   * flush loop persists it. */
  source?: 'local' | 'seed' | 'external'
  /** Set only when this write IS the resolution of an external conflict
   * (watcher "reopen"), so the conflict gate below is bypassed. */
  resolvesConflict?: boolean
}

/**
 * Assign the body mirror. The ONLY place `bodyMarkdown` is written.
 * `updateDocBody` calls it; pre-hydration seeding and editor→mirror caching
 * (which are construction/copies, not transforms) call it directly. Once
 * `CollabHandle.bodyMarkdown` becomes `readonly`, this cast is the single
 * sanctioned escape hatch — the blessed transient mutation of a non-reactive
 * store field.
 */
export function setBodyMirror(handle: CollabHandle, next: string): void {
  ;(handle as unknown as { bodyMarkdown: string }).bodyMarkdown = next
}

/**
 * A doc's body RIGHT NOW: the live editor when one is mounted on this slug,
 * else the mirror. The canonical read that complements `updateDocBody` /
 * `setBodyMirror` — any consumer that wants "the current content of this doc"
 * goes through here, never reads `handle.bodyMarkdown` directly (which lags the
 * editor between mount and unmount, since the flush no longer writes the mirror
 * back). Returns '' when the doc has no handle.
 */
export function readDocBody(slug: string): string {
  const live = pullActiveCmBody(slug)
  if (live !== null) return live
  return useDocsStore.getState().handles[slug]?.bodyMarkdown ?? ''
}

/**
 * Atomically read → transform → write a doc's body, owning all four concerns
 * every writer previously had to remember: (1) per-slug serialization, so a
 * read-modify-write can't interleave and lose an update; (2) hydration, so it
 * never transforms the empty pre-load cache; (3) reading the LIVE editor when
 * one is mounted, so it can't clobber keystrokes not yet flushed to the mirror;
 * (4) dirty-marking so the single disk writer (docFileSync flush) persists it.
 *
 * `transform` MUST be synchronous — do any async prep (LLM call, disk read)
 * before calling. Failure is a returned result, never a throw, and never
 * mutates the mirror.
 */
export async function updateDocBody(
  slug: string,
  transform: (current: string) => string,
  opts: UpdateDocBodyOpts = {},
): Promise<UpdateDocBodyResult> {
  return runExclusive(slug, async () => {
    await useDocsStore.getState().ensureHandle(slug)
    const handle = useDocsStore.getState().handles[slug]
    if (!handle) return { ok: false, reason: 'no-handle' }

    try {
      await handle.contentReady
    } catch {
      return { ok: false, reason: 'hydrate-failed' }
    }

    // While an editor is mounted on this slug, its own state is the
    // authoritative body — read that, not the possibly-stale mirror.
    const current = pullActiveCmBody(slug) ?? handle.bodyMarkdown

    // Don't overwrite a doc with an unresolved external change unless this
    // write is that resolution. Report, don't clobber.
    if (!opts.resolvesConflict && hasExternalConflict(slug)) {
      return { ok: false, reason: 'conflict' }
    }

    const next = transform(current)
    if (next === current) return { ok: true, changed: false }

    setBodyMirror(handle, next)
    // Reflect into the live editor if one is mounted (no-op otherwise); the
    // set is annotated to skip its own dirty tracking.
    applyMarkdownToActiveCmEditor(slug, next, opts.changeId)
    if (opts.source === 'external') clearDirty(slug)
    else markSlugDirty(slug)
    return { ok: true, changed: true }
  })
}
