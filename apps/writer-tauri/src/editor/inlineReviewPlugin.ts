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
import { useEditorViewStore } from '@/state/editorViewStore'
import { renderMarkdownToFragment } from '@/lib/renderMarkdownInline'
import { looseFindRange, looseReplace } from '@/lib/looseMatch'
import { splitEdit } from '@/lib/intraEditDiff'
import {
  computePendingHunks,
  type PendingHunk,
} from '@/lib/computePendingHunks'
import {
  reconcilePendingInserts,
  reconcilePendingDeletes,
  getSuggestionMark,
  parseMarkId,
} from './markReconcile'
import { anchorToTargets, isBlockInsertionReplace } from './pendingTargets'
import { findTextRange } from './anchorSearch'

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

/** What `resolveAnchor` returns for one edit. Four outcomes:
 *   - `placed`   — single anchor (partial edit or write-on-empty-page).
 *                  The widget / mark lands at that anchor.
 *   - `hunks`    — multiple per-line hunks (whole-file replace on a
 *                  populated page). Each hunk becomes its own remove
 *                  mark or add widget so the user sees exactly which
 *                  lines / blocks change, not a whole-body overlay.
 *   - `unplaced` — tried to pin but the literal target isn't in the
 *                  doc (LLM data mismatch). Surfaced via the
 *                  top-of-doc banner so the change isn't lost.
 *   - `silent`   — defer to another surface (panel) with no inline
 *                  presence. Used when the diff is empty (snapshot
 *                  === after, nothing to show). */
export type AnchorResolution =
  | { status: 'placed'; anchor: ResolvedAnchor }
  | { status: 'hunks'; hunks: PendingHunk[]; applyReady: boolean }
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

  // Whole-file replace (Phase F declarative-only edits): `kind` is
  // 'replace' but `before` is undefined — the LLM sent the full new
  // body via `propose_write`. To show "what actually changed" instead
  // of the whole body as a green overlay, we line-diff snapshot vs
  // `after` and surface each hunk on its own (remove mark + add
  // widget). Snapshot is the live `bodyMarkdown` at resolve time; on
  // an empty page or a structure mismatch we fall back to the prior
  // single-anchor behaviour so first-writes still render the proposed
  // body inline.
  if (edit.kind === 'replace' && !edit.before) {
    const after = edit.after ?? ''
    if (bodyMd.length === 0) {
      // Empty page (or handle still loading) — render the whole
      // proposed body as a single widget at the top.
      return {
        status: 'placed',
        anchor: { insertAt: 0, applyReady: true },
      }
    }
    const hunks = computePendingHunks(bodyMd, after, doc)
    if (!hunks) {
      // AST/PM structure mismatch — graceful fallback.
      return {
        status: 'placed',
        anchor: { insertAt: 0, applyReady: true },
      }
    }
    if (hunks.length === 0) {
      // snapshot === after — nothing to show.
      return { status: 'silent' }
    }
    return { status: 'hunks', hunks, applyReady: true }
  }

  // replace / delete with a literal `before`: need the range in the doc
  const target = edit.before
  if (!target) return { status: 'unplaced' }
  const range = findTextRange(doc, target)
  if (range) {
    // Keep stays enabled whenever the apply path could locate `target` —
    // mirror its tolerant matcher (not a bare literal `includes`) so the
    // button isn't disabled for an edit that would actually apply.
    const applyReady = looseFindRange(bodyMd, target) !== null
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

  // No single contiguous block range. Almost always a `before` that
  // spans block boundaries (multi-line) — findTextRange searches block
  // by block, so it can't pin a target that crosses paragraphs / list
  // items, even though the disk apply could. Reproduce the disk apply
  // (looseReplace on bodyMarkdown — the SAME matcher Keep uses) and
  // surface the result as block-level hunks via the whole-file-replace
  // pipeline. This keeps draw ⟺ apply in lockstep: if the edit would
  // apply, it draws here; if not, it stays unplaced.
  const newBody = looseReplace(bodyMd, target, edit.after ?? '')
  if (newBody !== null && newBody !== bodyMd) {
    const hunks = computePendingHunks(bodyMd, newBody, doc)
    if (hunks && hunks.length > 0) {
      return { status: 'hunks', hunks, applyReady: true }
    }
  }
  return { status: 'unplaced' }
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

// Anchor resolution (findTextRange) lives in ./anchorSearch — the
// single editor-side resolver, shared so wikilink + marker
// normalization is defined once. See that module's header.

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

// The decoration set is built by buildMarkNativeDecorations (below) —
// the single builder now that block-shaped pending renders as real
// nodes + marks. (The old widget-based `buildDecorations` for the
// read-only preview was removed with EmbeddedPreviewEditor.)

// ── Widget renderers ────────────────────────────────────────────

/** Build the widget DOM for added content.
 *
 * Strategy: render `after` through `renderMarkdownToFragment` — the
 * lightweight, self-contained markdown→DOM helper that handles the
 * subset the LLM emits (headings, single-level bullets, blockquotes,
 * paragraphs, links / wikilinks, bold). It deliberately avoids
 * Milkdown's `parserCtx`: that parser is bound to the editor's ctx
 * lifecycle and throws `Should not call a context out of the plugin`
 * when invoked from a deferred decoration-widget factory. The lighter
 * renderer keeps the widget reliably visible at the cost of pixel
 * parity with the eventual applied content — acceptable for a
 * preview, and "close enough" because both surfaces use the same
 * editor typography class.
 *
 * Container shape (inline `<span>` vs block `<div>`) is decided from
 * the parsed fragment, not a regex on the source. A single paragraph
 * with only inline children renders inline (the wrapping `<p>` is
 * unwrapped so it flows next to the surrounding cursor). Anything
 * with a heading, list, blockquote, multi-paragraph, or other
 * block-level node renders as a block widget below. */
function renderAfterWidget(
  change: PendingChange,
  after: string,
  opts: { keepDisabled: boolean },
): HTMLElement {
  const fragment = renderMarkdownToFragment(after)
  if (!fragment.childNodes.length) {
    return renderFallbackBlockWidget(change, after, opts)
  }

  const inlineChildren = extractInlineFlow(fragment)
  if (inlineChildren) {
    const root = document.createElement('span')
    root.className = 'pending-add-widget pending-add-widget--inline'
    root.dataset.pendingEdit = 'after-inline'

    const content = document.createElement('span')
    content.className = 'pending-add-widget__content'
    for (const child of inlineChildren) content.appendChild(child)
    root.appendChild(content)

    root.appendChild(buildActionsRow(change, { keepDisabled: opts.keepDisabled }))
    return root
  }

  const root = document.createElement('div')
  root.className = 'pending-add-widget pending-add-widget--block'
  root.dataset.pendingEdit = 'after-block'

  const content = document.createElement('div')
  content.className = 'pending-add-widget__content ProseMirror pending-edit-tone pending-edit-tone--add'
  content.style.minHeight = '0'
  content.style.cursor = 'default'
  content.appendChild(fragment)
  root.appendChild(content)

  root.appendChild(buildActionsRow(change, { keepDisabled: opts.keepDisabled }))
  return root
}

/** Plain-text block widget used when `renderMarkdownToFragment`
 * produced no nodes (truly empty `after`, or unsupported markdown).
 * Renders the raw string preformatted so the user still sees what
 * the change carries. */
function renderFallbackBlockWidget(
  change: PendingChange,
  after: string,
  opts: { keepDisabled: boolean },
): HTMLElement {
  const root = document.createElement('div')
  root.className = 'pending-add-widget pending-add-widget--block'
  root.dataset.pendingEdit = 'after-block-fallback'

  const content = document.createElement('div')
  content.className = 'pending-add-widget__content'
  content.style.whiteSpace = 'pre-wrap'
  content.textContent = after
  root.appendChild(content)

  root.appendChild(buildActionsRow(change, { keepDisabled: opts.keepDisabled }))
  return root
}

/** Decide whether the parsed fragment can render as an inline-flow
 * widget. Returns the inline children (extracted from the wrapping
 * `<p>`) when yes, or null when the content carries block-level
 * structure that requires a block widget.
 *
 * Inline-flow criteria:
 *   - exactly one top-level child
 *   - that child is a `<p>`
 *   - every descendant child of the paragraph is an inline node
 *     (text, link, em, strong, code, …) — no block-level nesting */
function extractInlineFlow(fragment: DocumentFragment): ChildNode[] | null {
  const children = Array.from(fragment.childNodes)
  if (children.length !== 1) return null
  const only = children[0]
  if (!(only instanceof HTMLElement)) return null
  if (only.tagName.toLowerCase() !== 'p') return null
  for (const child of only.childNodes) {
    if (!isInlineNode(child)) return null
  }
  return Array.from(only.childNodes)
}

const INLINE_TAGS = new Set([
  'a', 'em', 'strong', 'code', 's', 'u', 'span', 'br',
  'sup', 'sub', 'mark', 'small', 'b', 'i', 'del', 'ins',
])

function isInlineNode(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return true
  if (n.nodeType !== Node.ELEMENT_NODE) return false
  return INLINE_TAGS.has((n as HTMLElement).tagName.toLowerCase())
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

/** Render the decorations for a placed `replace` / `delete` edit
 * (the inline-shaped path shared by the live editor and the panel
 * preview). Both surfaces call this so they stay identical.
 *
 * For a `replace`, an intra-edit diff (splitEdit) trims the unchanged
 * head/tail so only the part that actually changed is marked: removed
 * middle gets a red strike, added middle a green widget. This stops an
 * insertion-expressed-as-replace (`before` = anchor, `after` = anchor +
 * new line) from double-showing the unchanged anchor as both struck and
 * added. The trim is char-offset → doc-position safe only for a
 * single-line `before` (positions map 1:1 within one text line), so a
 * multi-line `before` falls back to whole-range strike + whole-after
 * widget. */
function pushReplaceDecorations(
  decorations: Decoration[],
  change: PendingChange,
  edit: PendingEdit,
  anchor: ResolvedAnchor,
): void {
  const { from, to, applyReady } = anchor

  if (edit.kind === 'delete') {
    if (from !== undefined && to !== undefined) {
      decorations.push(
        Decoration.inline(from, to, { class: 'pending-mark--remove' }),
      )
      decorations.push(
        Decoration.widget(
          to,
          () => renderDeleteActions(change, { keepDisabled: !applyReady }),
          { side: 1, key: `${change.id}:${edit.id}:actions` },
        ),
      )
    }
    return
  }

  const before = edit.before ?? ''
  const after = edit.after ?? ''

  // Single-line before → safe to trim to the true delta.
  if (from !== undefined && to !== undefined && !before.includes('\n')) {
    const { prefixLen, suffixLen, removed, added } = splitEdit(before, after)
    const rmFrom = from + prefixLen
    const rmTo = to - suffixLen
    if (removed.length > 0 && rmTo > rmFrom) {
      decorations.push(
        Decoration.inline(rmFrom, rmTo, { class: 'pending-mark--remove' }),
      )
    }
    if (added.length > 0) {
      decorations.push(
        Decoration.widget(
          rmTo,
          () => renderAfterWidget(change, added, { keepDisabled: !applyReady }),
          { side: 1, key: `${change.id}:${edit.id}:after` },
        ),
      )
    } else if (removed.length > 0) {
      // Pure deletion within a line still needs a decision chip.
      decorations.push(
        Decoration.widget(
          rmTo,
          () => renderDeleteActions(change, { keepDisabled: !applyReady }),
          { side: 1, key: `${change.id}:${edit.id}:actions` },
        ),
      )
    }
    return
  }

  // Fallback: multi-line before — mark the whole range + whole after.
  if (from !== undefined && to !== undefined) {
    decorations.push(
      Decoration.inline(from, to, { class: 'pending-mark--remove' }),
    )
  }
  if (anchor.insertAt !== undefined) {
    decorations.push(
      Decoration.widget(
        anchor.insertAt,
        () => renderAfterWidget(change, after, { keepDisabled: !applyReady }),
        { side: 1, key: `${change.id}:${edit.id}:after` },
      ),
    )
  }
}

// ── Mark-native rendering ───────────────────────────────────────
//
// Block-shaped pending content (a pure `add`, or a whole-file `replace`
// diffed into hunks) is NOT drawn as a widget. Instead the view() layer
// inserts real PM nodes + `proofSuggestion` marks (insert / delete) via
// the reconcile engine, so Milkdown's NodeViews render it identically
// to committed body. Phase 0's strip keeps that content off disk.
//
// Decorations therefore shrink to:
//   - INLINE pending (replace-with-a-literal-before, pure delete): the
//     existing strike + small inline widget — no block NodeView to
//     mismatch against, so the widget stays.
//   - one Keep/Reject chip per mark-native change, anchored at its
//     first materialised pending mark (found by scanning the doc).
//   - the unplaced banner.

/** True when an entry's content is rendered as nodes + marks (handled
 * by reconcile) rather than a decoration. Mirrors `anchorToTargets`'s
 * block-shape predicate so the two never disagree on which path owns
 * a given edit. */
function isMarkNativeEntry(edit: PendingEdit, res: AnchorResolution): boolean {
  if (res.status === 'hunks') return true
  if (res.status === 'placed') {
    return (
      edit.kind === 'add' ||
      (edit.kind === 'replace' && !edit.before) ||
      isBlockInsertionReplace(edit)
    )
  }
  return false
}

/** Map each pending change that has materialised marks in the doc to
 * the END position of its LAST pending region (insert node or delete
 * range). The chip lands just AFTER the changed content (side: 1) so it
 * reads left-to-right "<change> [Reject Keep]" rather than floating to
 * the left of it. Keyed by the change id parsed from the mark's `id`
 * attr (`${change.id}:${edit.id}[:hunk:i]`). */
function scanPendingChangeAnchors(doc: PMNode): Map<string, number> {
  const out = new Map<string, number>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const mark = getSuggestionMark(node)
    if (!mark || (mark.attrs.kind !== 'insert' && mark.attrs.kind !== 'delete')) {
      return true
    }
    const parsed = parseMarkId(mark.attrs.id as string)
    if (!parsed) return true
    const end = pos + node.nodeSize
    const cur = out.get(parsed.changeId)
    if (cur === undefined || end > cur) out.set(parsed.changeId, end)
    return true
  })
  return out
}

/** Standalone Reject / Keep chip for a mark-native change — the
 * content lives in the doc as real nodes, so the chip floats beside
 * it rather than wrapping it. */
function renderChip(change: PendingChange): HTMLElement {
  const root = document.createElement('span')
  root.className = 'pending-add-widget pending-add-widget--inline'
  root.dataset.pendingEdit = 'chip'
  root.appendChild(buildActionsRow(change, { keepDisabled: false }))
  return root
}

/** The plugin's decoration set. Block-shaped pending is drawn
 * by nodes + marks (see reconcile); this only adds inline-pending
 * decorations, the per-change chips, and the unplaced banner. */
function buildMarkNativeDecorations(
  doc: PMNode,
  resolved: ResolvedEntry[],
): DecorationSet {
  const decorations: Decoration[] = []
  let unplacedCount = 0
  const changeById = new Map<string, PendingChange>()
  for (const e of resolved) changeById.set(e.change.id, e.change)

  for (const entry of resolved) {
    const res = entry.resolution
    if (res.status === 'silent') continue
    if (res.status === 'unplaced') {
      unplacedCount += 1
      continue
    }
    if (res.status === 'hunks') continue // nodes + marks + doc-scan chip
    // res.status === 'placed'
    if (isMarkNativeEntry(entry.edit, res)) continue // add / empty-replace → nodes
    // INLINE pending (replace-with-before / delete): keep the widget
    // path, trimmed to the true delta via the shared helper.
    pushReplaceDecorations(decorations, entry.change, entry.edit, res.anchor)
  }

  // One chip per materialised change, just after its content (side: 1).
  for (const [changeId, pos] of scanPendingChangeAnchors(doc)) {
    const change = changeById.get(changeId)
    if (!change) continue
    decorations.push(
      Decoration.widget(pos, () => renderChip(change), {
        side: 1,
        key: `chip:${changeId}`,
      }),
    )
  }

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

// ── Plugin wiring ──────────────────────────────────────────────

export const inlineReviewKey = new PluginKey<PluginState>('inline-review')

const STORE_UPDATE_META = 'storeUpdate'

interface StoreUpdateMeta {
  type: typeof STORE_UPDATE_META
  pending: PendingChange[]
}

export function inlineReviewPluginSpec(slug: string): Plugin<PluginState> {
  return (
      new Plugin<PluginState>({
        key: inlineReviewKey,
        state: {
          init(_config, state) {
            const pending = collectPendingForSlug(slug)
            const resolved = resolveAll(state.doc, pending)
            return {
              decorations: buildMarkNativeDecorations(state.doc, resolved),
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
                decorations: buildMarkNativeDecorations(newState.doc, resolved),
                resolved,
              }
            }
            if (!tr.docChanged) return prev
            // Doc transaction. Four cases per entry:
            //   - 'placed':   map the single anchor's stored positions
            //   - 'hunks':    map every hunk's pmFrom/pmTo/pmAt
            //   - 'unplaced': re-resolve — a doc change may have
            //                 brought the target into existence
            //   - 'silent':   could also flip (page was emptied →
            //                 whole-file replace now wants a widget),
            //                 so re-resolve too
            let anyPromoted = false
            const resolved = prev.resolved.map((entry) => {
              if (
                entry.resolution.status === 'unplaced' ||
                entry.resolution.status === 'silent'
              ) {
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
              if (entry.resolution.status === 'hunks') {
                const mappedHunks: PendingHunk[] = entry.resolution.hunks.map(
                  (h) =>
                    h.type === 'remove'
                      ? {
                          ...h,
                          pmFrom: tr.mapping.map(h.pmFrom),
                          pmTo: tr.mapping.map(h.pmTo),
                        }
                      : { ...h, pmAt: tr.mapping.map(h.pmAt) },
                )
                return {
                  ...entry,
                  resolution: {
                    status: 'hunks' as const,
                    hunks: mappedHunks,
                    applyReady: entry.resolution.applyReady,
                  },
                }
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
                ? buildMarkNativeDecorations(newState.doc, resolved)
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
          // Materialise block-shaped pending content as nodes + marks so
          // it renders through Milkdown's NodeViews. Resolved against the
          // LIVE doc; deletes (marks, position-preserving) dispatch first
          // so the insert positions stay valid. Both reconcile passes are
          // idempotent — a no-op when the doc already matches — so this is
          // safe to re-run on every store change without looping (a stable
          // doc yields null and nothing dispatches).
          // Returns false when the parser isn't ready yet (caller may
          // retry), true once a reconcile pass actually ran.
          const runReconcile = (): boolean => {
            const parser = useEditorViewStore.getState().parser
            if (!parser) return false
            const parse = (md: string) => parser(md).content
            const pending = collectPendingForSlug(slug)
            const targets = pending.flatMap((change) =>
              change.edits.map((edit) =>
                anchorToTargets(
                  resolveAnchor(view.state.doc, edit, change.pageSlug),
                  `${change.id}:${edit.id}`,
                  edit,
                  view.state.doc,
                  parse,
                ),
              ),
            )
            const deletes = targets.flatMap((t) => t.deletes)
            const inserts = targets.flatMap((t) => t.inserts)
            const trD = reconcilePendingDeletes(view.state, deletes)
            if (trD) view.dispatch(trD)
            const trI = reconcilePendingInserts(view.state, inserts)
            if (trI) view.dispatch(trI)
            return true
          }

          // Defer the initial materialise — the editor publishes its
          // parser to editorViewStore during create(), which may not
          // have landed when view() first runs. Retry across a few
          // frames until the parser is ready, then stop; a no-op stays
          // a no-op.
          // Track the pending frame so destroy() can cancel it — without
          // this, a queued tryReconcile can fire after the view is torn
          // down (parser not ready within 30 frames, or a fast doc switch
          // right after mount) and dispatch on a destroyed view, which
          // ProseMirror rejects ("updateState on a destroyed view").
          let attempts = 0
          let rafId = 0
          const tryReconcile = () => {
            rafId = 0
            if (runReconcile()) return
            if (attempts++ < 30) rafId = requestAnimationFrame(tryReconcile)
          }
          rafId = requestAnimationFrame(tryReconcile)

          let lastSerialised = serialisePending(
            collectPendingForSlug(slug),
          )
          const unsubscribe = usePendingChangesStore.subscribe(() => {
            const pending = collectPendingForSlug(slug)
            const serialised = serialisePending(pending)
            if (serialised === lastSerialised) return
            lastSerialised = serialised
            runReconcile()
            const metaUpdate: StoreUpdateMeta = {
              type: STORE_UPDATE_META,
              pending,
            }
            view.dispatch(view.state.tr.setMeta(inlineReviewKey, metaUpdate))
          })
          return {
            destroy() {
              if (rafId) cancelAnimationFrame(rafId)
              unsubscribe()
            },
          }
        },
      })
  )
}

export function createInlineReviewPlugin(slug: string) {
  return $prose(() => inlineReviewPluginSpec(slug))
}

function collectPendingForSlug(slug: string): PendingChange[] {
  const all = Object.values(usePendingChangesStore.getState().byId)
  return all
    .filter((c) => c.pageSlug === slug && c.status === 'pending')
    .sort((a, b) => a.createdAt - b.createdAt)
}

function serialisePending(pending: PendingChange[]): string {
  // A decision removes the entry from this (pending-only) list, so the
  // serialized string changes and the subscriber rebuilds — no need to
  // encode status.
  return pending.map((c) => `${c.id}:${c.edits.length}`).join('|')
}
