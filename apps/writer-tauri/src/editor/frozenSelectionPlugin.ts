// Frozen selection — keeps the user's last non-empty selection visible
// (and accessible by external callers) while focus moves to the chat
// input. Without this, slash commands like `/polish` lose their context
// the moment the user clicks the prompt textarea: ProseMirror retains
// state.selection, but the browser only paints native selection on the
// focused element, so the highlight visually disappears and the UX
// reads as "my selection got dropped."
//
// Design:
//   - Plugin state holds an optional { from, to } range.
//   - On editor.dom blur we snapshot the current selection if non-empty.
//   - On editor.dom focus we clear the snapshot — the live selection
//     takes over again.
//   - Every transaction maps the range through tr.mapping so collab
//     edits arriving from other clients don't shift the snapshot off
//     its anchor.
//   - props.decorations renders an inline decoration with a CSS class
//     that mimics the native selection color, so the user keeps seeing
//     what's "attached" to the chat run.
//
// External API: `getFrozenRange(view)` lets the chat panel read the
// snapshot when the live selection has collapsed. `frozenRangeKey` is
// exported so callers can subscribe via plugin state if they need
// finer-grained reactivity later.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'

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
          apply(tr, prev): FrozenState {
            const meta = tr.getMeta(frozenRangeKey) as FrozenMeta | undefined
            if (meta) {
              if (meta.type === 'clear') return { range: null }
              return { range: { from: meta.from, to: meta.to } }
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
            focus(view) {
              const cur = frozenRangeKey.getState(view.state)
              if (!cur?.range) return false
              view.dispatch(
                view.state.tr.setMeta(frozenRangeKey, { type: 'clear' } satisfies FrozenMeta),
              )
              return false
            },
          },
          decorations(state) {
            const s = frozenRangeKey.getState(state)
            if (!s?.range) return null
            return DecorationSet.create(state.doc, [
              Decoration.inline(s.range.from, s.range.to, {
                class: 'milkdown-frozen-selection',
              }),
            ])
          },
        },
      }),
  )
}
