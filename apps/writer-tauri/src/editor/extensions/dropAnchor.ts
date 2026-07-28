// A pending-insertion anchor that survives edits. Media drop/paste imports the file
// ASYNCHRONOUSLY (a vault copy), then inserts its card markdown when the import resolves.
// The drop position captured up front is only valid against the doc AT DROP TIME —
// canon: a position held across transactions must be MAPPED through their changes, never
// just clamped. So we register the drop offset here, map it on every doc change, and read
// the up-to-date offset back when the import lands. Keyed by a caller-supplied id so
// several concurrent drops track independently.

import { StateField, StateEffect } from '@codemirror/state'

export const addDropAnchor = StateEffect.define<{ id: number; pos: number }>()
export const clearDropAnchor = StateEffect.define<number>()

export const dropAnchorField = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value
    if (tr.docChanged && value.size) {
      const mapped = new Map<number, number>()
      for (const [id, pos] of value) mapped.set(id, tr.changes.mapPos(pos, 1))
      next = mapped
    }
    for (const e of tr.effects) {
      if (e.is(addDropAnchor)) {
        const m = new Map(next)
        m.set(e.value.id, e.value.pos)
        next = m
      } else if (e.is(clearDropAnchor) && next.has(e.value)) {
        const m = new Map(next)
        m.delete(e.value)
        next = m
      }
    }
    return next
  },
})
