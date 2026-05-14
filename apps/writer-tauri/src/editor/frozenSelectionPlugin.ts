// Frozen selection — keeps the user's last non-empty selection
// available to the chat panel after the editor loses focus, so a
// slash command like `/polish` knows what range it's attached to.
//
// Design:
//   - Plugin state holds an optional { from, to } range.
//   - On editor.dom blur we snapshot the current selection if non-empty.
//   - Every transaction maps the range through tr.mapping so collab
//     edits arriving from other clients don't shift the snapshot off
//     its anchor.
//
// No visual: the chat panel chip already shows the captured text, so
// painting an inline decoration over the editor range was a redundant
// second affordance. It also caused phantom highlights — any blur
// (DevTools, context menu, NodeView CE=false click) snapshotted, and
// the focus-back event was unreliable enough that stale green boxes
// would linger in the body. Removing the paint takes that whole class
// of bug off the table; the chip is the single source of truth for
// "selection still attached."
//
// External API: `getFrozenRange(view)` lets the chat panel read the
// snapshot when the live selection has collapsed. `clearFrozenRange`
// drops it (used by the chip's X button).

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

interface FrozenState {
  range: { from: number; to: number } | null
}

type FrozenMeta =
  | { type: 'set'; from: number; to: number }
  | { type: 'clear' }

export const frozenRangeKey = new PluginKey<FrozenState>('frozenSelection')

/** Read the current frozen range from the plugin state. Returns null
 * when the editor has focus (live selection is the source of truth) or
 * when the user never made a non-empty selection before blurring. */
export function getFrozenRange(view: EditorView): { from: number; to: number } | null {
  return frozenRangeKey.getState(view.state)?.range ?? null
}

/** Drop the frozen snapshot. Used by the chat-input chip's X button so
 * the user can explicitly detach a selection without going back to the
 * editor. Doesn't touch the live PM selection — callers handle that
 * when they also need to collapse it. */
export function clearFrozenRange(view: EditorView): void {
  const cur = frozenRangeKey.getState(view.state)
  if (!cur?.range) return
  view.dispatch(
    view.state.tr.setMeta(frozenRangeKey, { type: 'clear' } satisfies FrozenMeta),
  )
}

export function createFrozenSelectionPlugin() {
  return $prose(
    () =>
      new Plugin<FrozenState>({
        key: frozenRangeKey,
        state: {
          init(): FrozenState {
            return { range: null }
          },
          apply(tr, prev, oldState, newState): FrozenState {
            const meta = tr.getMeta(frozenRangeKey) as FrozenMeta | undefined
            if (meta) {
              if (meta.type === 'clear') return { range: null }
              return { range: { from: meta.from, to: meta.to } }
            }
            // Fresh non-empty selection in the editor → user is back,
            // snapshot is stale.
            if (
              prev.range &&
              !newState.selection.empty &&
              !oldState.selection.eq(newState.selection)
            ) {
              return { range: null }
            }
            // Map the range across doc edits so collab inserts/deletes
            // upstream don't shift the snapshot relative to its anchor.
            // Drop the snapshot if the mapping collapses it (the anchored
            // text was deleted).
            if (prev.range && tr.docChanged) {
              const from = tr.mapping.map(prev.range.from)
              const to = tr.mapping.map(prev.range.to)
              if (from >= to) return { range: null }
              return { range: { from, to } }
            }
            return prev
          },
        },
        props: {
          handleDOMEvents: {
            blur(view) {
              const sel = view.state.selection
              if (sel.empty) return false
              view.dispatch(
                view.state.tr.setMeta(frozenRangeKey, {
                  type: 'set',
                  from: sel.from,
                  to: sel.to,
                } satisfies FrozenMeta),
              )
              return false
            },
          },
        },
      }),
  )
}
