// PM plugin that surfaces pendingChangesStore entries as inline
// decorations on the active editor view. Cursor-style:
//
//   - Removed text (replace / delete): marked in place with a red
//     tint + strikethrough using `Decoration.inline`. The text isn't
//     mutated — only its visual style — so a Reject leaves zero
//     residue and a Keep does the real edit via the disk-write path.
//
//   - Added text (add / replace): rendered as a `Decoration.widget`
//     right at the insertion point. Inline (span, green tint) for
//     paragraph-shaped `after`; block (div) for content that carries
//     headings / lists / multiple paragraphs.
//
//   - Each change carries a small `[Reject] [Keep]` chip, embedded
//     in the widget DOM next to the added content (or floating right
//     after the deleted range for pure delete).
//
//   - When `before` (or `anchorBefore` for add) can't be pinned to
//     a position in the live doc OR in the page's serialized
//     markdown — the rare LLM-bug / drift case — the widget is NOT
//     placed at a misleading position. Instead a small "unplaced"
//     chip lands at the top of the doc telling the user there are
//     changes waiting in the Review panel.
//
// Anchor resolution strategy (the foundation):
//   1. literal PM text content match (covers most cases)
//   2. normalized PM text content match — strip leading list / heading
//      markers from `target` and retry (covers `- 31살` → `31살`)
//   3. give up → null → unplaced banner
//
// The applier (`applyToWikiPage`) does its own match against
// `handle.bodyMarkdown`. We also surface that as the `applyReady`
// flag so Keep stays disabled iff the apply would fail — a divergent
// match (visible in PM but missing in serialized md) is rare but
// possible.
//
// Resolved positions are mapped forward through doc transactions
// via `tr.mapping`; full re-resolution only happens on store
// updates (push / accept / reject) or when an entry is unresolvable
// and a doc change might bring its target into existence (hydrate
// after editor mount).

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import {
  usePendingChangesStore,
  type PendingChange,
  type PendingEdit,
} from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { useLayoutStore } from '@/state/layoutStore'
import { buildDiffHunkProseBody } from '@/lib/diffHunk/proseDom'

// ── Resolved anchor ─────────────────────────────────────────────

/** What the resolver returns for a single edit.
 *   - replace: `from`/`to` cover the existing text to mark removed;
 *              `insertAt` (= `to`) is where the added content goes
 *   - delete:  `from`/`to` cover the existing text; no `insertAt`
 *   - add:     only `insertAt` (the position to inject content)
 *
 * `applyReady` tracks whether the host's apply path (which matches
 * against `handle.bodyMarkdown`, not PM text) can succeed. Mirrors
 * the predicate `applyToWikiPage` uses — keeps the Keep button in
 * lockstep with apply success. */
export interface ResolvedAnchor {
  from?: number
  to?: number
  insertAt?: number
  applyReady: boolean
}

/** What `resolveAnchor` returns for one edit. Three distinct
 * outcomes:
 *   - `placed`   — the inline plugin renders the change at this anchor
 *   - `unplaced` — the inline plugin tried to pin the change but the
 *                  literal target isn't in the doc (LLM data mismatch);
 *                  the user is told via the top-of-doc "unplaced"
 *                  banner so the change isn't lost
 *   - `silent`   — the inline plugin deliberately defers to another
 *                  surface (typically the Review panel); no banner,
 *                  no widget. Used for whole-file replaces on pages
 *                  that already carry content, where overlaying the
 *                  full proposed body would duplicate what the panel
 *                  already shows. */
export type AnchorResolution =
  | { status: 'placed'; anchor: ResolvedAnchor }
  | { status: 'unplaced' }
  | { status: 'silent' }

interface ResolvedEntry {
  change: PendingChange
  edit: PendingEdit
  resolution: AnchorResolution
}

// ── Anchor resolution ───────────────────────────────────────────

/** Resolve a single edit's anchor against the current PM doc + the
 * slug's `bodyMarkdown`. */
export function resolveAnchor(
  doc: PMNode,
  edit: PendingEdit,
  slug: string,
): AnchorResolution {
  const bodyMd = useDocsStore.getState().handles[slug]?.bodyMarkdown ?? ''

  if (edit.kind === 'add') {
    const insertAt = resolveAddInsertion(doc, edit.anchorBefore)
    if (insertAt === null) return { status: 'unplaced' }
    return {
      status: 'placed',
      anchor: { insertAt, applyReady: true },
    }
  }

  // Whole-file replace (Phase F declarative-only edits): `kind`
  // is 'replace' but `before` is undefined, which means the LLM
  // declared the full target state via `propose_write`. The apply
  // path routes this to `applyWriteWikiPage` (whole-file overwrite),
  // which never fails on a match check — there's nothing to match.
  //
  // The inline surface only makes sense when the page is otherwise
  // EMPTY: anchor the proposed content at the top so the user sees
  // the new state in place of the empty page. When the page already
  // has content, "where" is undefined — the whole page is being
  // replaced, not any particular position — and a giant top-of-doc
  // widget over real content reads as redundant noise. Review panel
  // shows the diff for that case; we go 'silent' here.
  if (edit.kind === 'replace' && !edit.before) {
    if (isDocEmpty(doc)) {
      return {
        status: 'placed',
        anchor: { insertAt: 0, applyReady: true },
      }
    }
    return { status: 'silent' }
  }

  // replace / delete with a literal `before`: need the range in the doc
  const target = edit.before
  if (!target) return { status: 'unplaced' }
  const range = findTextRange(doc, target)
  if (!range) return { status: 'unplaced' }

  const applyReady = bodyMd.includes(target)
  if (edit.kind === 'delete') {
    return {
      status: 'placed',
      anchor: { from: range.from, to: range.to, applyReady },
    }
  }
  // replace
  return {
    status: 'placed',
    anchor: {
      from: range.from,
      to: range.to,
      insertAt: range.to,
      applyReady,
    },
  }
}

/** True when the doc carries no user content — a single empty
 * paragraph (PM's "blank canvas" shape) or nothing at all. Used to
 * decide whether a whole-file replace proposal deserves an inline
 * preview widget: empty pages do (the widget IS the preview), pages
 * with content don't (the Review panel handles the diff). */
function isDocEmpty(doc: PMNode): boolean {
  if (doc.content.size === 0) return true
  if (doc.childCount !== 1) return false
  const first = doc.firstChild
  if (!first) return true
  if (!first.isTextblock) return false
  return first.content.size === 0
}

/** Find the PM position where `add`-kind content should land:
 *   - empty `anchorBefore` → end of doc (append)
 *   - non-empty → just after the last occurrence of the anchor */
function resolveAddInsertion(
  doc: PMNode,
  anchorBefore: string,
): number | null {
  if (anchorBefore.length === 0) return doc.content.size
  // Search last occurrence — for repeated anchors (blank lines etc.)
  // the LLM's intent is usually "after the last one".
  const range = findTextRange(doc, anchorBefore, { last: true })
  if (!range) return null
  return range.to
}

/** Find `target` in the doc's text nodes. Returns the first
 * occurrence's range, or the last when `opts.last`. Returns null
 * when neither literal nor markdown-normalized form matches. */
function findTextRange(
  doc: PMNode,
  target: string,
  opts: { last?: boolean } = {},
): { from: number; to: number } | null {
  const literal = searchPmText(doc, target, opts.last)
  if (literal) return literal
  // Markdown normalization: strip the first line's list / heading /
  // blockquote marker. Covers the common case where the LLM emits
  // `- 31살` but PM's text node carries only `31살` (the bullet
  // marker is drawn by the list-item NodeView, not in text content).
  const normalized = stripFirstLineMarkdownMarker(target)
  if (normalized && normalized !== target) {
    const fallback = searchPmText(doc, normalized, opts.last)
    if (fallback) return fallback
  }
  return null
}

/** Walk text nodes; return the (first or last) occurrence of
 * `target` as a PM-position range. */
function searchPmText(
  doc: PMNode,
  target: string,
  last = false,
): { from: number; to: number } | null {
  if (target.length === 0) return null
  let result: { from: number; to: number } | null = null
  doc.descendants((node, nodePos) => {
    if (!last && result) return false
    if (!node.isText || !node.text) return true
    const idx = last
      ? node.text.lastIndexOf(target)
      : node.text.indexOf(target)
    if (idx >= 0) {
      result = { from: nodePos + idx, to: nodePos + idx + target.length }
      if (!last) return false
    }
    return true
  })
  return result
}

/** Strip the leading line's markdown block marker so a `target`
 * like "- 31살" becomes "31살" — the form that survives PM's
 * text-content view (bullets are NodeView-drawn, not text). */
function stripFirstLineMarkdownMarker(s: string): string {
  const nl = s.indexOf('\n')
  const firstLine = nl >= 0 ? s.slice(0, nl) : s
  const rest = nl >= 0 ? s.slice(nl) : ''
  // Match: heading (# ## ###), list bullet (- * +), ordered (1.),
  // blockquote (>) — followed by required whitespace.
  const stripped = firstLine.replace(
    /^(?:#+\s+|[-*+]\s+|\d+\.\s+|>\s+)/,
    '',
  )
  return stripped + rest
}

// ── Decoration build ────────────────────────────────────────────

interface PluginState {
  decorations: DecorationSet
  resolved: ResolvedEntry[]
}

function resolveAll(doc: PMNode, pending: PendingChange[]): ResolvedEntry[] {
  const out: ResolvedEntry[] = []
  for (const change of pending) {
    for (const edit of change.edits) {
      out.push({
        change,
        edit,
        resolution: resolveAnchor(doc, edit, change.pageSlug),
      })
    }
  }
  return out
}

function buildDecorations(
  doc: PMNode,
  resolved: ResolvedEntry[],
): DecorationSet {
  const decorations: Decoration[] = []
  let unplacedCount = 0

  for (const entry of resolved) {
    // 'silent': the plugin deliberately defers to another surface
    // (Review panel). No widget, no banner — the entry isn't lost,
    // it's just not the inline plugin's job.
    if (entry.resolution.status === 'silent') continue
    // 'unplaced': we tried to pin and couldn't. Surface in the banner
    // so the user knows changes exist.
    if (entry.resolution.status === 'unplaced') {
      unplacedCount += 1
      continue
    }
    const { change, edit } = entry
    const anchor = entry.resolution.anchor

    // 1. Mark the removed range (replace / delete).
    if (
      (edit.kind === 'replace' || edit.kind === 'delete') &&
      anchor.from !== undefined &&
      anchor.to !== undefined
    ) {
      decorations.push(
        Decoration.inline(anchor.from, anchor.to, {
          class: 'pending-mark--remove',
        }),
      )
    }

    // 2. Widget for the added content + actions (add / replace), or
    //    just the actions chip when this is a pure delete.
    if (anchor.insertAt !== undefined && edit.kind !== 'delete') {
      const after = edit.after ?? ''
      const isBlock = looksLikeBlockMarkdown(after)
      decorations.push(
        Decoration.widget(
          anchor.insertAt,
          () =>
            renderAfterWidget(change, after, {
              isBlock,
              keepDisabled: !anchor.applyReady,
            }),
          {
            side: 1,
            key: `${change.id}:${edit.id}:after`,
          },
        ),
      )
    } else if (edit.kind === 'delete' && anchor.to !== undefined) {
      decorations.push(
        Decoration.widget(
          anchor.to,
          () =>
            renderDeleteActions(change, {
              keepDisabled: !anchor.applyReady,
            }),
          {
            side: 1,
            key: `${change.id}:${edit.id}:actions`,
          },
        ),
      )
    }
  }

  // 3. Single "unplaced" banner at the top of the doc when any
  //    entries failed to anchor. Tells the user to open the Review
  //    panel without misleading them about WHERE the change was.
  if (unplacedCount > 0) {
    decorations.push(
      Decoration.widget(0, () => renderUnplacedBanner(unplacedCount), {
        side: -1,
        key: `unplaced:${unplacedCount}`,
      }),
    )
  }

  return DecorationSet.create(doc, decorations)
}

/** Heuristic: does this `after` text want a block-level widget?
 *   - multi-line with a blank line (separate blocks) → block
 *   - starts with a markdown block marker (#, -, *, +, N., >, ```) → block
 *   - otherwise → inline (it's a single paragraph / phrase) */
function looksLikeBlockMarkdown(s: string): boolean {
  if (s.includes('\n\n')) return true
  if (/^(?:#+\s|[-*+]\s|\d+\.\s|>\s|```)/.test(s.trimStart())) return true
  return false
}

// ── Widget renderers ────────────────────────────────────────────

/** Build the widget DOM for added content. Inline `<span>` for
 * paragraph-shaped content (flows next to the cursor); block `<div>`
 * for content that carries headings / lists / multiple paragraphs.
 * Each widget includes a small actions chip on the right. */
function renderAfterWidget(
  change: PendingChange,
  after: string,
  opts: { isBlock: boolean; keepDisabled: boolean },
): HTMLElement {
  if (opts.isBlock) {
    const root = document.createElement('div')
    root.className = 'pending-add-widget pending-add-widget--block'
    root.dataset.pendingEdit = 'after-block'

    const content = document.createElement('div')
    content.className = 'pending-add-widget__content'
    content.appendChild(buildDiffHunkProseBody(undefined, after))
    root.appendChild(content)

    root.appendChild(buildActionsRow(change, { keepDisabled: opts.keepDisabled }))
    return root
  }

  // Inline: span flow next to the anchor character. Plain text
  // content + actions chip both live inside the span so the chip
  // floats with the inline text.
  const root = document.createElement('span')
  root.className = 'pending-add-widget pending-add-widget--inline'
  root.dataset.pendingEdit = 'after-inline'

  const content = document.createElement('span')
  content.className = 'pending-add-widget__content'
  // Strip a leading newline if present — for inline insertion we
  // want the text to flow without an unintended line break.
  content.textContent = after.replace(/^\n+/, '')
  root.appendChild(content)

  root.appendChild(buildActionsRow(change, { keepDisabled: opts.keepDisabled }))
  return root
}

/** Pure-delete edits have no added content but still need an
 * actions chip the user can click. Small floating affordance right
 * after the marked-removed range. */
function renderDeleteActions(
  change: PendingChange,
  opts: { keepDisabled: boolean },
): HTMLElement {
  const root = document.createElement('span')
  root.className = 'pending-add-widget pending-add-widget--inline'
  root.dataset.pendingEdit = 'delete-actions'
  root.appendChild(buildActionsRow(change, { keepDisabled: opts.keepDisabled }))
  return root
}

/** Top-of-doc banner that appears when at least one pending change
 * couldn't be pinned to a doc position. Clicking opens the Review
 * panel — the user can decide on the unplaced change there even
 * though we can't show it in context. */
function renderUnplacedBanner(count: number): HTMLElement {
  const root = document.createElement('div')
  root.className = 'pending-unplaced-banner'
  root.dataset.pendingEdit = 'unplaced'

  const text = document.createElement('span')
  text.className = 'pending-unplaced-banner__text'
  text.textContent =
    count === 1
      ? '1 pending change — couldn’t place in this page'
      : `${count} pending changes — couldn’t place in this page`
  root.appendChild(text)

  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'pending-unplaced-banner__link'
  link.textContent = 'Open Review panel'
  link.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    useLayoutStore.getState().setRightPanelMode('review')
  })
  root.appendChild(link)

  return root
}

/** Shared Reject / Keep chip. Same class set as the Review panel's
 * PendingDetail so both surfaces look identical. */
function buildActionsRow(
  change: PendingChange,
  opts: { keepDisabled?: boolean } = {},
): HTMLElement {
  const actions = document.createElement('span')
  actions.className = 'pending-edit__actions'

  const rejectBtn = document.createElement('button')
  rejectBtn.type = 'button'
  rejectBtn.className = 'pending-edit__action pending-edit__action--reject'
  rejectBtn.textContent = 'Reject'
  rejectBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    usePendingChangesStore.getState().reject(change.id)
  })
  actions.appendChild(rejectBtn)

  const keepBtn = document.createElement('button')
  keepBtn.type = 'button'
  keepBtn.className = 'pending-edit__action pending-edit__action--keep'
  keepBtn.textContent = 'Keep'
  if (opts.keepDisabled) keepBtn.disabled = true
  keepBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    usePendingChangesStore.getState().accept(change.id)
  })
  actions.appendChild(keepBtn)

  return actions
}

// ── Plugin wiring ──────────────────────────────────────────────

export const inlineReviewKey = new PluginKey<PluginState>('inline-review')

const STORE_UPDATE_META = 'storeUpdate'

interface StoreUpdateMeta {
  type: typeof STORE_UPDATE_META
  pending: PendingChange[]
}

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
              const resolved = resolveAll(newState.doc, meta.pending)
              return {
                decorations: buildDecorations(newState.doc, resolved),
                resolved,
              }
            }
            if (!tr.docChanged) return prev
            // Doc transaction. Three cases per entry:
            //   - 'placed':   map stored positions forward via tr.mapping
            //   - 'unplaced': re-resolve — a doc change may have
            //                 brought the target into existence (typical
            //                 during the seed-after-mount tick)
            //   - 'silent':   could also flip (page was emptied →
            //                 whole-file replace now wants a widget),
            //                 so re-resolve too
            let anyPromoted = false
            const resolved = prev.resolved.map((entry) => {
              if (entry.resolution.status !== 'placed') {
                const fresh = resolveAnchor(
                  newState.doc,
                  entry.edit,
                  entry.change.pageSlug,
                )
                if (fresh.status !== entry.resolution.status) {
                  anyPromoted = true
                }
                return { ...entry, resolution: fresh }
              }
              const a = entry.resolution.anchor
              const mapped: ResolvedAnchor = {
                from: a.from !== undefined ? tr.mapping.map(a.from) : undefined,
                to: a.to !== undefined ? tr.mapping.map(a.to) : undefined,
                insertAt:
                  a.insertAt !== undefined ? tr.mapping.map(a.insertAt) : undefined,
                applyReady: a.applyReady,
              }
              return {
                ...entry,
                resolution: { status: 'placed' as const, anchor: mapped },
              }
            })
            // If any non-placed entry just changed status, rebuild
            // from scratch (the banner count + decoration set both
            // need to be re-derived).
            return {
              decorations: anyPromoted
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
          // Surface a presentation signal on the editor's outer DOM
          // when any pending entry is rendered (placed widget OR
          // unplaced banner). CSS reads this to suppress the
          // body-placeholder hint — without it the "Start writing…"
          // hint paints under our widget on an empty page, which
          // contradicts what the user sees. The placeholder plugin
          // stays domain-naive; this is presentation-layer
          // coordination via a generic "has overlay" signal.
          attributes(state): Record<string, string> {
            const pluginState = inlineReviewKey.getState(state)
            if (!pluginState) return {}
            // Only count entries the inline plugin actually renders
            // (placed widget or unplaced banner). 'silent' entries
            // defer to the panel and shouldn't suppress the body
            // placeholder — the page truly has nothing inline-y.
            const visible = pluginState.resolved.some(
              (e) => e.resolution.status !== 'silent',
            )
            return visible ? { class: 'pm-has-pending' } : {}
          },
        },
        view(view) {
          let lastSerialised = serialisePending(collectPendingForSlug(slug))
          const unsubscribe = usePendingChangesStore.subscribe(() => {
            const pending = collectPendingForSlug(slug)
            const serialised = serialisePending(pending)
            if (serialised === lastSerialised) return
            lastSerialised = serialised
            const metaUpdate: StoreUpdateMeta = {
              type: STORE_UPDATE_META,
              pending,
            }
            view.dispatch(view.state.tr.setMeta(inlineReviewKey, metaUpdate))
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

function collectPendingForSlug(slug: string): PendingChange[] {
  return Object.values(usePendingChangesStore.getState().byId)
    .filter((c) => c.status === 'pending' && c.pageSlug === slug)
    .sort((a, b) => a.createdAt - b.createdAt)
}

function serialisePending(pending: PendingChange[]): string {
  return pending.map((c) => `${c.id}:${c.edits.length}`).join('|')
}
