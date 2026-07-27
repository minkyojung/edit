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
import { smartEnterKeymap } from '@/editor/extensions/listEnter'

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

  // The constraint the comments at buildExtensions.ts:143/:149 actually state, and
  // which was unpinnable until `smartEnterKeymap` got a name: all three bind Enter
  // at Prec.highest, so the ONLY thing deciding who claims the key is registration
  // ORDER. Each picker returns false when its menu is closed, so smartEnter still
  // runs the rest of the time — but if either moved after smartEnter, Enter would
  // continue the list instead of confirming the highlighted menu item.
  //
  // SCOPE: this asserts order, which is the half that was unprotected. It does NOT
  // assert precedence — lowering slashKeymap's Prec would still let smartEnter win
  // and this would stay green. That needs a behavioral test (dispatch Enter with the
  // menu open and assert the menu consumed it), which is the follow-up.
  it('slash and wikilink pickers are REGISTERED before smartEnter', () => {
    const idx = (e: unknown) => ext.indexOf(e as (typeof ext)[number])
    expect(idx(smartEnterKeymap)).toBeGreaterThanOrEqual(0)
    expect(idx(slashKeymap)).toBeLessThan(idx(smartEnterKeymap))
    expect(idx(wikilinkKeymap)).toBeLessThan(idx(smartEnterKeymap))
  })

  // The pickers' own relative order was never documented, yet their keysets are
  // IDENTICAL (Enter, Tab, ArrowUp, ArrowDown, Escape) at the same precedence.
  // It is benign today only because each returns false while closed. Pin it so a
  // future binding that does NOT return false can't silently change the winner.
  it('slashKeymap precedes wikilinkKeymap (identical keysets, same precedence)', () => {
    const idx = (e: unknown) => ext.indexOf(e as (typeof ext)[number])
    expect(idx(slashKeymap)).toBeLessThan(idx(wikilinkKeymap))
  })
})
