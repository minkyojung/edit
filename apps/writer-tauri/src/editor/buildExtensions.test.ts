// Order-contract proof for the extension factory. The 39 extensions are order-
// sensitive (keymap precedence + IME correctness), and a reorder would break keymaps
// silently — the headless suite can't drive real keystrokes, so we pin the two things
// we CAN observe cheaply: the array length, and the relative order of the front
// Prec.highest / early extensions by object identity. If someone reorders the array,
// one of these assertions flips.

import { describe, expect, it } from 'vitest'
import { buildEditorExtensions } from './buildExtensions'
import { slashMenu, slashKeymap } from '@/editor/slashMenu'
import { wikilinkMenu, wikilinkKeymap } from '@/editor/wikilinkMenu'
import { tableArrowEntry } from '@/editor/livepreview/editableTable'
import { blockVerticalNav } from '@/editor/extensions/blockVerticalNav'

describe('buildEditorExtensions — order contract', () => {
  const ext = buildEditorExtensions({ slug: 'my-note', scheduleStats: () => {} })

  it('returns exactly 39 extensions', () => {
    expect(ext.length).toBe(39)
  })

  it('preserves the front ordering slash → wikilink → … → tableArrowEntry → blockVerticalNav', () => {
    const idx = (e: unknown) => ext.indexOf(e as (typeof ext)[number])
    // Every anchor must be present.
    for (const e of [slashMenu, slashKeymap, wikilinkMenu, wikilinkKeymap, tableArrowEntry, blockVerticalNav]) {
      expect(idx(e)).toBeGreaterThanOrEqual(0)
    }
    // slash owns Enter before the wikilink picker, which owns Enter before the
    // deterministic smartEnter keymap; table arrow-entry then vertical block nav
    // sit later in the stack. Strictly increasing indices lock that chain.
    expect(idx(slashMenu)).toBeLessThan(idx(slashKeymap))
    expect(idx(slashKeymap)).toBeLessThan(idx(wikilinkMenu))
    expect(idx(wikilinkMenu)).toBeLessThan(idx(wikilinkKeymap))
    expect(idx(wikilinkKeymap)).toBeLessThan(idx(tableArrowEntry))
    expect(idx(tableArrowEntry)).toBeLessThan(idx(blockVerticalNav))
  })
})
