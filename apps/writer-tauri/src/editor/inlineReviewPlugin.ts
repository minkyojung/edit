// PM plugin that surfaces pendingChangesStore entries as inline
// decorations on the active editor view. This module is the glue
// between the store (host-side state) and ProseMirror's
// DecorationSet (editor-side rendering).
//
// C1 scope: infrastructure only. The plugin subscribes to the store,
// resolves each pending change's anchor into a PM doc position, and
// keeps the position list current as the user types or external
// edits arrive (via `DecorationSet.map`). No visualisation yet —
// `buildDecorations` returns an empty DecorationSet at this step;
// C2 will populate it with the inline diff (green / red), C3 with
// the Accept / Reject widget buttons.
//
// Why this shape:
//   - The plugin must outlive any single transaction so the
//     decoration list survives doc edits.
//   - Anchor lookup happens once per store change (subscribe →
//     dispatch). Doc-only transactions just map existing positions.
//     That keeps the anchor-search cost O(store changes) rather
//     than O(doc transactions).
//   - Anchor resolution is pure (`resolveAnchorPosition`) so it
//     can be unit-tested without standing up a PM editor.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import {
  usePendingChangesStore,
  type PendingChange,
} from '@/state/pendingChangesStore'

/** Resolved anchor — what `resolveAnchorPosition` returns. */
export interface ResolvedAnchor {
  /** PM doc position (0-based, between-token semantics). */
  pos: number
  /** True when the match used the literal `anchorBefore` string;
   * false when we fell back to "end of doc" because anchor was
   * empty or unmatched. Surface for diagnostics. */
  exact: boolean
}

/** Convert a content-based anchor into a PM doc position.
 *
 * Rules (in priority order):
 *   1. Empty anchor → end of doc. Ingest proposals use this since
 *      the legacy auto-apply path always appends.
 *   2. Anchor found in doc's flat text → position immediately AFTER
 *      the last character of the matched substring. "After" because
 *      `anchorBefore` semantically means "the text immediately
 *      preceding the insertion".
 *   3. Anchor not found → fall back to end of doc. Marked `exact:
 *      false` so callers (or diagnostics) can see the miss.
 *
 * Why textBetween instead of node walking: a content-based anchor
 * is a flat string by design — node structure isn't part of the
 * matching contract. The two-pass cost (textBetween + indexOf) is
 * cheap at our doc sizes; if it ever shows up in a profile we can
 * cache per-doc-version.
 *
 * Pure / testable: no zustand reads, no decoration construction.
 * Caller supplies `doc`, function returns position. */
export function resolveAnchorPosition(
  doc: PMNode,
  anchorBefore: string,
): ResolvedAnchor {
  const endPos = doc.content.size
  if (anchorBefore.length === 0) {
    return { pos: endPos, exact: false }
  }
  // `textBetween` with `\n` separators gives us a deterministic flat
  // string we can search. The position we compute is in the same
  // coordinate space as PM's doc.size — PM counts each text char as
  // one position and block boundaries as one position each, which
  // is exactly what `\n` separation models.
  const flat = doc.textBetween(0, endPos, '\n', '\n')
  const idx = flat.lastIndexOf(anchorBefore)
  if (idx < 0) return { pos: endPos, exact: false }
  return { pos: idx + anchorBefore.length, exact: true }
}

interface PluginState {
  decorations: DecorationSet
  /** Cached resolved positions for each pending change. Recomputed
   * when the store changes; mapped forward when the doc changes. */
  resolved: Array<{ change: PendingChange; anchorPos: number }>
}

export const inlineReviewKey = new PluginKey<PluginState>('inline-review')

/** Meta key for store-driven updates. Setting `tr.setMeta(inlineReviewKey, {
 * pending })` triggers a full rebuild against the fresh pending list. */
const STORE_UPDATE_META = 'storeUpdate'

interface StoreUpdateMeta {
  type: typeof STORE_UPDATE_META
  pending: PendingChange[]
}

/** Build the DecorationSet from a list of resolved anchors.
 *
 * C2 — Widget-only strategy: every pending "add" edit becomes one
 * `Decoration.widget(pos, dom)` inserted at the anchor position.
 * The DOM lives ABOVE the PM document (PM treats widgets as
 * out-of-band), so the editor's body / serializer / flushDirty are
 * untouched. That keeps the widget compatible with Phase A.5's
 * auto-apply (the disk write produces real content; the widget
 * decorates the to-be-added preview).
 *
 * C3 will add the Accept / Reject buttons inside the same widget
 * (extending `renderPendingWidget` to populate `.pending-edit__actions`).
 *
 * `'replace'` / `'delete'` edits are produced by chat in Phase E;
 * for now ingest only emits `'add'` so we short-circuit anything
 * else and the decoration set stays clean. */
function buildDecorations(
  doc: PMNode,
  resolved: PluginState['resolved'],
): DecorationSet {
  const decorations: Decoration[] = []
  for (const entry of resolved) {
    for (const edit of entry.change.edits) {
      if (edit.kind !== 'add' || !edit.after) continue
      // `widget` decorations don't participate in document
      // serialization — PM treats them as a DOM-only side channel
      // anchored to a position. side: 1 keeps the widget after the
      // anchor's character so its visual order matches "would be
      // appended here" semantics.
      decorations.push(
        Decoration.widget(
          entry.anchorPos,
          () => renderPendingWidget(entry.change, edit.after ?? ''),
          { side: 1, key: `${entry.change.id}:${edit.id}` },
        ),
      )
    }
  }
  return DecorationSet.create(doc, decorations)
}

/** Build the DOM node for a single pending-add edit. C2 keeps the
 * preview as plain text (whitespace preserved via CSS) — the
 * `### Career\n- Promoted...` shape is recognisable enough at this
 * stage without standing up a full markdown sub-renderer.
 *
 * Structure:
 *   <div class="pending-edit pending-edit--add">
 *     <div class="pending-edit__body">{preview text}</div>
 *     <div class="pending-edit__actions">
 *       <button class="...--keep">Keep</button>
 *       <button class="...--remove">Remove</button>
 *     </div>
 *   </div>
 *
 * Button handlers call the store directly. The store mutation
 * triggers a re-build via the plugin's view subscription, which
 * removes this widget on the next tick — no manual DOM cleanup. */
function renderPendingWidget(
  change: PendingChange,
  preview: string,
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'pending-edit pending-edit--add'
  // Mark this node so future PM passes (e.g. dailyGuardPlugin) can
  // ignore widget DOM. PM already isolates widgets from doc
  // serialization, but the data attribute is a cheap belt-and-
  // suspenders affordance for any code walking the editor DOM.
  root.dataset.pendingEdit = 'add'

  const body = document.createElement('div')
  body.className = 'pending-edit__body'
  body.textContent = preview
  root.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'pending-edit__actions'

  const keepBtn = document.createElement('button')
  keepBtn.type = 'button'
  keepBtn.className =
    'pending-edit__action pending-edit__action--keep'
  keepBtn.textContent = 'Keep'
  keepBtn.addEventListener('click', (e) => {
    // Stop the click from bubbling into the editor (PM would
    // otherwise read it as a selection change and re-focus the
    // editor mid-action).
    e.preventDefault()
    e.stopPropagation()
    usePendingChangesStore.getState().accept(change.id)
  })
  actions.appendChild(keepBtn)

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className =
    'pending-edit__action pending-edit__action--remove'
  removeBtn.textContent = 'Remove'
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    usePendingChangesStore.getState().reject(change.id)
  })
  actions.appendChild(removeBtn)

  root.appendChild(actions)
  return root
}

/** Plugin factory. Bound to a specific doc slug so the editor only
 * surfaces changes for the doc it's currently rendering. */
export function createInlineReviewPlugin(slug: string) {
  return $prose(
    () =>
      new Plugin<PluginState>({
        key: inlineReviewKey,
        state: {
          init(_config, state) {
            const pending = collectPendingForSlug(slug)
            const resolved = pending.map((change) => ({
              change,
              anchorPos: resolveAnchorPosition(
                state.doc,
                change.edits[0]?.anchorBefore ?? '',
              ).pos,
            }))
            return {
              decorations: buildDecorations(state.doc, resolved),
              resolved,
            }
          },
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(inlineReviewKey) as
              | StoreUpdateMeta
              | undefined
            if (meta?.type === STORE_UPDATE_META) {
              // Store changed — rebuild from the fresh pending list.
              // The doc may also have changed in the same tr (rare
              // but possible), so use `newState.doc`.
              const resolved = meta.pending.map((change) => ({
                change,
                anchorPos: resolveAnchorPosition(
                  newState.doc,
                  change.edits[0]?.anchorBefore ?? '',
                ).pos,
              }))
              return {
                decorations: buildDecorations(newState.doc, resolved),
                resolved,
              }
            }
            // Doc transaction — map existing positions forward, leave
            // the resolved list otherwise unchanged. PM's mapping
            // handles inserts before / after / inside the anchored
            // position correctly; we just delegate.
            if (!tr.docChanged) return prev
            const resolved = prev.resolved.map((entry) => ({
              change: entry.change,
              anchorPos: tr.mapping.map(entry.anchorPos),
            }))
            return {
              decorations: prev.decorations.map(tr.mapping, newState.doc),
              resolved,
            }
          },
        },
        props: {
          decorations(state) {
            return inlineReviewKey.getState(state)?.decorations
          },
        },
        view(view) {
          // Subscribe to the store and push updates into the plugin
          // via a no-op transaction. We dispatch only when the
          // filtered pending list for this slug actually changes —
          // otherwise we'd churn the plugin state on every unrelated
          // store mutation (other pages' changes).
          let lastSerialised = serialisePending(collectPendingForSlug(slug))
          const unsubscribe = usePendingChangesStore.subscribe(() => {
            const pending = collectPendingForSlug(slug)
            const serialised = serialisePending(pending)
            if (serialised === lastSerialised) return
            lastSerialised = serialised
            const meta: StoreUpdateMeta = {
              type: STORE_UPDATE_META,
              pending,
            }
            view.dispatch(view.state.tr.setMeta(inlineReviewKey, meta))
          })
          return {
            destroy() {
              unsubscribe()
            },
          }
        },
      }),
  )
}

/** Pull pending entries for one slug, sorted by createdAt. Mirrors
 * the store's selector but lives here so the plugin doesn't have
 * to import it through the React hook surface. */
function collectPendingForSlug(slug: string): PendingChange[] {
  return Object.values(usePendingChangesStore.getState().byId)
    .filter((c) => c.status === 'pending' && c.pageSlug === slug)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Cheap structural fingerprint so the subscribe handler can skip
 * dispatching when nothing relevant changed. Includes id + status
 * + edit count — anything that would alter the decoration set. */
function serialisePending(pending: PendingChange[]): string {
  return pending.map((c) => `${c.id}:${c.edits.length}`).join('|')
}
