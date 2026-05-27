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
  type PendingEdit,
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
 *   2. Anchor matches a single text node in the doc → PM position
 *      immediately AFTER the matched substring.
 *   3. Anchor matches a single text node after stripping line-leading
 *      markdown prefixes (`* `, `- `, `# `, `> `, `1. `, etc.) — the
 *      LLM's Edit tool quotes raw markdown (the on-disk shape) but
 *      PM stores it as structured content with the markers absorbed
 *      into node types. Without this fallback every chat replace on
 *      a bullet / heading / quote misses.
 *   4. Neither hits → end of doc with `exact: false`. The replace
 *      widget renders this in stale mode (Keep disabled).
 *
 * Why per-text-node walk instead of `doc.textBetween` + `indexOf`
 * (the E3.5 shape): `textBetween` replaces each block boundary
 * with a single character (`\n`), but PM positions count each
 * block open + close as TWO positions. So a flat-text index drifts
 * away from the equivalent PM position by 1 per block crossed —
 * fine on a one-paragraph doc, badly wrong on a long page with
 * many headings / list items. Walking text nodes directly lets us
 * read positions from PM's own coordinate space, eliminating the
 * drift. (E3.7 fix.)
 *
 * Known limit: target must live within ONE text node. PM splits
 * text at every mark boundary, so a target spanning `**bold**` or
 * a `[link](url)` won't match. Common-case chat Edits quote plain
 * prose, which lives in a single text node — good enough for v1.
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

  // Rule 2 — literal target in a single text node.
  let r = findInTextNodes(doc, anchorBefore)
  if (r.exact) return r

  // Rule 3 — same walk against the stripped target.
  const stripped = stripMarkdownLinePrefixes(anchorBefore)
  if (stripped !== anchorBefore && stripped.length > 0) {
    r = findInTextNodes(doc, stripped)
    if (r.exact) return r
  }

  return { pos: endPos, exact: false }
}

/** Walk the doc tree looking for `target` inside a single text
 * node. Returns the PM position immediately AFTER the match (so
 * a widget anchored there reads as "right after this text"). Uses
 * `lastIndexOf` to match the legacy semantics of preferring the
 * later occurrence when a doc happens to repeat the same string. */
function findInTextNodes(
  doc: PMNode,
  target: string,
): ResolvedAnchor {
  let foundPos = -1
  doc.descendants((node, pos) => {
    if (foundPos >= 0) return false
    if (!node.isText || !node.text) return true
    const idx = node.text.lastIndexOf(target)
    if (idx >= 0) {
      // `pos` is the PM position before this text node's first
      // character. `idx + target.length` is the offset within
      // the node text to the end of the match. Sum is the PM
      // position immediately after the match.
      foundPos = pos + idx + target.length
      return false
    }
    return true
  })
  if (foundPos >= 0) return { pos: foundPos, exact: true }
  return { pos: doc.content.size, exact: false }
}

/** Strip line-leading markdown syntax. Handles the common cases the
 * LLM emits as `old_string`:
 *   - bullets:    `* `, `- `, `+ `
 *   - ordered:    `1. `, `12. `
 *   - headings:   `# ` through `###### `
 *   - blockquote: `> `
 * Inline syntax (bold, italic, links) is deliberately left alone —
 * those need a more careful handler and aren't the common miss. */
function stripMarkdownLinePrefixes(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.replace(/^(?:[*+-]|#{1,6}|>|\d+\.)\s+/, ''),
    )
    .join('\n')
}

/** One resolved (change, edit) pair. Per-edit rather than per-change
 * because chat changes can carry multiple edits (MultiEdit) and each
 * one has its own anchor — `before` for replace, `anchorBefore` for
 * add. Building decorations directly off this list keeps the
 * rendering loop simple. */
interface ResolvedEntry {
  change: PendingChange
  edit: PendingEdit
  /** PM doc position the widget anchors at:
   *   - add:     position after `anchorBefore` (end of doc when empty)
   *   - replace: position after the matched `before` text
   *   - stale:   end of doc (when the search target wasn't found) */
  anchorPos: number
  /** True when the anchor matched the literal search target. False
   * when we fell back to end-of-doc — drives the `--stale` modifier
   * the widget uses to grey out Keep on out-of-context replacements. */
  exact: boolean
}

interface PluginState {
  decorations: DecorationSet
  /** Cached resolved positions for each pending edit. Recomputed
   * when the store changes; mapped forward when the doc changes. */
  resolved: ResolvedEntry[]
}

/** Pick the right search target for the resolver based on edit kind.
 *   - add:     `anchorBefore` (the text preceding the insertion point)
 *   - replace: `before` (the text being replaced)
 *   - delete:  `before` (same as replace — the text being removed)
 *
 * Centralised here so `state.init` / `apply` / `view.dispatch` all
 * stay in lockstep when we add more kinds later. */
function searchTargetForEdit(edit: PendingEdit): string {
  if (edit.kind === 'add') return edit.anchorBefore
  return edit.before ?? edit.anchorBefore
}

/** Walk every pending change's edits and resolve each to a PM
 * position. One entry per edit, not per change, because different
 * edits in the same change can land at different positions
 * (MultiEdit). */
function resolveAll(doc: PMNode, pending: PendingChange[]): ResolvedEntry[] {
  const out: ResolvedEntry[] = []
  for (const change of pending) {
    for (const edit of change.edits) {
      const resolved = resolveAnchorPosition(doc, searchTargetForEdit(edit))
      out.push({
        change,
        edit,
        anchorPos: resolved.pos,
        exact: resolved.exact,
      })
    }
  }
  return out
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
  resolved: ResolvedEntry[],
): DecorationSet {
  const decorations: Decoration[] = []
  for (const entry of resolved) {
    const { change, edit, anchorPos, exact } = entry
    if (edit.kind === 'add') {
      if (!edit.after) continue
      // `widget` decorations don't participate in document
      // serialization — PM treats them as a DOM-only side channel
      // anchored to a position. side: 1 keeps the widget after the
      // anchor's character so its visual order matches "would be
      // appended here" semantics.
      decorations.push(
        Decoration.widget(
          anchorPos,
          () => renderAddWidget(change, edit.after ?? ''),
          { side: 1, key: `${change.id}:${edit.id}` },
        ),
      )
      continue
    }
    if (edit.kind === 'replace') {
      // Replace shows a diff card anchored after the `before` text in
      // the doc. The original text stays visible (we don't strike it
      // through inline — that would mutate the visual flow of
      // unchanged content). The widget itself carries the diff.
      decorations.push(
        Decoration.widget(
          anchorPos,
          () =>
            renderReplaceWidget(
              change,
              edit.before ?? '',
              edit.after ?? '',
              { stale: !exact },
            ),
          { side: 1, key: `${change.id}:${edit.id}` },
        ),
      )
      continue
    }
    // 'delete' kind (future) — would render a strike-through card.
  }
  return DecorationSet.create(doc, decorations)
}

/** Build the DOM for an `add` edit's preview widget. Plain text
 * preview, Keep / Reject buttons. The `### Career\n- Promoted...`
 * shape is recognisable without a full markdown sub-renderer. */
function renderAddWidget(
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

  root.appendChild(buildActionsRow(change))
  return root
}

/** Build the DOM for a `replace` edit's diff card. Shows the
 * `before` text in a red row and the `after` text in a green row,
 * stacked. The actual `before` text in the doc is NOT struck
 * through — keeping doc-content untouched until the user decides
 * means a Reject leaves zero residue and a Keep does its work via
 * the disk-write path (chat: SDK fires real Edit on allow).
 *
 * `stale` is set when the resolver couldn't find `before` in the
 * doc (user already edited that area, or the LLM cited a slightly
 * different string). The widget renders at end-of-doc in that case,
 * with a `--stale` modifier the caller can style as dimmed +
 * disabled-Keep so the user understands the replacement no longer
 * has a target. */
function renderReplaceWidget(
  change: PendingChange,
  before: string,
  after: string,
  opts: { stale: boolean },
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'pending-edit pending-edit--replace'
  if (opts.stale) root.classList.add('pending-edit--stale')
  root.dataset.pendingEdit = 'replace'

  if (opts.stale) {
    // One-line explanation at the top so the user understands why
    // Keep is disabled. Surfaces above the diff rows.
    const note = document.createElement('div')
    note.className = 'pending-edit__stale-note'
    note.textContent =
      'Original text no longer matches — Reject this change, or rerun.'
    root.appendChild(note)
  }

  const beforeRow = document.createElement('div')
  beforeRow.className = 'pending-edit__line pending-edit__line--before'
  beforeRow.textContent = `- ${before}`
  root.appendChild(beforeRow)

  const afterRow = document.createElement('div')
  afterRow.className = 'pending-edit__line pending-edit__line--after'
  afterRow.textContent = `+ ${after}`
  root.appendChild(afterRow)

  root.appendChild(buildActionsRow(change, { keepDisabled: opts.stale }))
  return root
}

/** Shared Keep / Reject buttons. Pulled out so add / replace render
 * identical action rows — visual variance lives in the body above. */
function buildActionsRow(
  change: PendingChange,
  opts: { keepDisabled?: boolean } = {},
): HTMLElement {
  const actions = document.createElement('div')
  actions.className = 'pending-edit__actions'

  const keepBtn = document.createElement('button')
  keepBtn.type = 'button'
  keepBtn.className =
    'pending-edit__action pending-edit__action--keep'
  keepBtn.textContent = 'Keep'
  if (opts.keepDisabled) keepBtn.disabled = true
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

  return actions
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
            const resolved = resolveAll(state.doc, pending)
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
              const resolved = resolveAll(newState.doc, meta.pending)
              return {
                decorations: buildDecorations(newState.doc, resolved),
                resolved,
              }
            }
            // Doc transaction — usually just map existing positions
            // forward. PM's mapping handles inserts before / after /
            // inside the anchored position correctly. The exception
            // is stale entries (exact=false): those resolved against
            // an earlier doc state that didn't contain the target,
            // and now the doc may have settled with the real content
            // (defaultValueCtx seed lands one tick after editor mount).
            // Give them another chance to find their target on every
            // doc change; exact entries skip the re-search.
            if (!tr.docChanged) return prev
            const resolved = prev.resolved.map((entry) => {
              if (entry.exact) {
                return { ...entry, anchorPos: tr.mapping.map(entry.anchorPos) }
              }
              const r = resolveAnchorPosition(
                newState.doc,
                searchTargetForEdit(entry.edit),
              )
              return { ...entry, anchorPos: r.pos, exact: r.exact }
            })
            // Rebuild decorations from scratch when any stale entry
            // just promoted to exact — the widget's `stale` prop
            // depends on the exact flag, and `decorations.map` would
            // carry forward the old (stale-styled) DOM.
            const promoted = prev.resolved.some(
              (entry, i) => !entry.exact && resolved[i]?.exact,
            )
            return {
              decorations: promoted
                ? buildDecorations(newState.doc, resolved)
                : prev.decorations.map(tr.mapping, newState.doc),
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
