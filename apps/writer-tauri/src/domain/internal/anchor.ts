/**
 * Anchor encoding — PM position ↔ Y.RelativePosition.
 *
 * Marks survive collaborative edits because their endpoints are stored
 * as Y.RelativePositions rather than absolute integers. The relative
 * position rides along the Yjs CRDT structure, so a paragraph the
 * user inserts above the mark shifts the absolute position but
 * leaves the relative one pointing at the same characters.
 *
 * y-prosemirror ships helpers that bridge between PM's absolute
 * position space and the underlying Yjs XmlFragment. We use them
 * directly here — there is no friendlier API, and the helpers are
 * the same ones the editor's collab binding uses internally, so
 * encoding agreement with PM transactions is guaranteed.
 *
 * Encoding format:
 *   The Y.RelativePosition is JSON-serialized to a string. Yjs's
 *   own encodeRelativePosition produces a Uint8Array, which would
 *   need base64 anyway to land in a Y.Map; JSON of the typed shape
 *   round-trips through Y.Map equally well and is easier to inspect
 *   when debugging.
 *
 * Both encode/decode require the EditorView (specifically the
 * ySyncPluginKey state) to be available. Failure to acquire it
 * means the doc isn't yet collab-bound, which is a caller
 * precondition violation — we throw rather than return null so the
 * problem surfaces at the call site.
 */

import type { EditorView } from '@milkdown/kit/prose/view'
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror'

interface YSyncState {
  type: unknown
  binding: { mapping: unknown }
}

/** Encode a PM document position as a string suitable for storing
 * in a Y.Map. Round-trips through `decodeAnchor` to recover a (
 * potentially shifted) PM position. */
export function encodeAnchor(view: EditorView, pos: number): string {
  const state = getYSyncState(view)
  const rel = absolutePositionToRelativePosition(
    pos,
    // y-prosemirror's types are loose here; we cast through unknown
    // to satisfy strict TS without losing the runtime contract.
    state.type as Parameters<typeof absolutePositionToRelativePosition>[1],
    state.binding.mapping as Parameters<typeof absolutePositionToRelativePosition>[2],
  )
  return JSON.stringify(rel)
}

/** Decode an anchor string back to a PM position. Returns null
 * when the encoding is malformed or the target text has been
 * deleted (Yjs can't resolve a relative position whose anchor is
 * gone). */
export function decodeAnchor(view: EditorView, encoded: string): number | null {
  const state = getYSyncState(view)
  let rel: unknown
  try {
    rel = JSON.parse(encoded)
  } catch {
    return null
  }
  const pos = relativePositionToAbsolutePosition(
    state.type as Parameters<typeof relativePositionToAbsolutePosition>[0],
    state.binding.mapping as unknown as Parameters<typeof relativePositionToAbsolutePosition>[1],
    rel as Parameters<typeof relativePositionToAbsolutePosition>[2],
    state.binding as unknown as Parameters<typeof relativePositionToAbsolutePosition>[3],
  )
  return pos ?? null
}

function getYSyncState(view: EditorView): YSyncState {
  const state = ySyncPluginKey.getState(view.state) as YSyncState | undefined
  if (!state || !state.type || !state.binding) {
    throw new Error(
      '[anchor] ySyncPluginKey state unavailable — the editor view is not bound to a Yjs doc yet',
    )
  }
  return state
}
