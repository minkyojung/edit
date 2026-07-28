// BASELINE for Phase 5 (widgetizing list markers + the task checkbox).
//
// Today list bullets and task markers are hidden with `Decoration.mark` +
// CSS `visibility: hidden` — the "Ixora trick", which keeps the marker's BOX so
// the caret keeps full height and revealing it causes no reflow. Every other
// marker (`#`, `**`, `](url)`, `[[`) uses `Decoration.replace({})`, which is zero
// width. The retained width is precisely why the caret lands inside a list marker
// and why a drag-selection swallows it.
//
// These tests do not assert that the current behavior is DESIRABLE. They pin it,
// so that when Phase 5 swaps in a replace+widget the diff is loud instead of
// silent. Expect to update them in that phase — that is the point.
//
// Not coverable here: drag-select extent and native drag-and-drop. jsdom has no
// layout engine and does not implement `Range.getClientRects`, so CM6's
// coordinate APIs throw rather than degrade. Those belong in the browser-mode
// specs (Phase 4).

import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { cursorCharRight } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import {
  _buildDecos,
  livePreviewV2,
  taskCheckboxClick,
  LIST_MARKER_END_PAD,
  TASK_BOX_EM,
} from './livePreview'

function stateFor(doc: string, anchor = doc.length, extra: unknown[] = []) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ extensions: [GFM] }), ...(extra as never[])],
  })
}

function mount(doc: string, anchor: number, extra: unknown[]) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({ parent, state: stateFor(doc, anchor, extra) })
}

const decosOf = (doc: string, anchor = doc.length) => {
  const state = stateFor(doc, anchor)
  return _buildDecos(state, [{ from: 0, to: state.doc.length }])
}

describe('T0.5 — how the list marker is hidden', () => {
  it('the bullet is a MARK (keeps its width), not a zero-width replace', () => {
    // The `-` occupies [0, 1). Caret parked at the end so the marker isn't revealed.
    const marker = decosOf('- item').find((r) => r.from === 0 && r.to === 1)
    expect(marker).toBeDefined()
    // A mark carries a class; `HIDE` is `Decoration.replace({})` and carries none.
    // Phase 5 flips this: the two assertions below are what must change.
    expect(marker!.value.spec.class).toContain('cm-list-marker')
    expect(marker!.value.spec.widget).toBeUndefined()
  })

  it('by contrast, an inline marker IS a zero-width replace', () => {
    // The bold run must be far from the caret, or the reveal gate keeps it raw.
    const doc = '**bold** and a good deal of trailing text'
    const opener = decosOf(doc).find((r) => r.from === 0 && r.to === 2)
    expect(opener).toBeDefined()
    expect(opener!.value.spec.class).toBeUndefined()
  })

  it('the caret stops INSIDE the hidden marker — two ArrowRights to reach "i"', () => {
    // `- item`: `-` is [0,1), the space is [1,2), content starts at 2. Because the
    // marker is a mark and not a replace, positions 1 and 2 both exist, so the
    // caret appears not to move on the first press. After Phase 5 this should
    // collapse to a single press.
    const view = mount('- item', 0, [livePreviewV2])
    cursorCharRight(view)
    expect(view.state.selection.main.head).toBe(1)
    cursorCharRight(view)
    expect(view.state.selection.main.head).toBe(2)
    view.destroy()
  })
})

describe('T0.4 — which mousedown handler consumes the click', () => {
  // The checkbox is a CSS `::after` pseudo-element and so can never be an event
  // target; the handler hit-tests the click against geometry derived from
  // `coordsAtPos`. jsdom throws on that (no layout), so both coordinate calls are
  // stubbed with a fake monospace metric. This pins the DECISION logic — is the
  // click inside the drawn box — not layout truth. Phase 5 deletes this math by
  // making the checkbox a real element.
  //
  // A sentinel handler is registered AFTER taskCheckboxClick for two reasons: it
  // records whether the click fell through (the actual T0.4 question), and it
  // stops an unconsumed mousedown from reaching CM's built-in mouse selection,
  // which would call the real `posAtCoords` and throw in jsdom.
  const LINE = '- [ ] task'

  function setup() {
    let fellThrough = false
    const sentinel = EditorView.domEventHandlers({
      mousedown() {
        fellThrough = true
        return true // swallow, so CM's built-in selection never runs
      },
    })
    const view = mount(LINE, LINE.length, [taskCheckboxClick, sentinel])
    // Marker `- [ ]` is [0,5); put its right edge at x=100 on a 16px line at y=10.
    // getComputedStyle().fontSize is "medium" in jsdom → NaN → the handler's `|| 16`
    // fallback applies, which is the 16 this geometry assumes.
    vi.spyOn(view, 'posAtCoords').mockReturnValue(0)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 100, right: 100, top: 10, bottom: 26 })
    return {
      view,
      click(x: number, y: number) {
        fellThrough = false
        view.contentDOM.dispatchEvent(
          new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
        )
        return fellThrough
      },
    }
  }

  // The drawn box, from cmTheme: inset LIST_MARKER_END_PAD (0.35em) from the marker
  // column's right edge, TASK_BOX_EM (1.05em) square. At fs=16 with the marker's
  // right edge at x=100 that is boxRight = 94.4, boxLeft = 77.6, cy = 18.
  const boxRight = 100 - LIST_MARKER_END_PAD * 16
  const boxLeft = boxRight - TASK_BOX_EM * 16

  it('a click inside the drawn box is consumed and toggles `[ ]` → `[x]`', () => {
    const { view, click } = setup()
    expect(click(90, 18)).toBe(false) // taskCheckboxClick won; sentinel never ran
    expect(view.state.doc.toString()).toBe('- [x] task')
    view.destroy()
  })

  it('a click right of the box falls through to the next handler', () => {
    const { view, click } = setup()
    expect(click(99, 18)).toBe(true)
    expect(view.state.doc.toString()).toBe(LINE)
    view.destroy()
  })

  it('a click above the box falls through', () => {
    const { view, click } = setup()
    expect(click(90, 0)).toBe(true)
    expect(view.state.doc.toString()).toBe(LINE)
    view.destroy()
  })

  // The two slivers the drifted constant got wrong. The hit-test used to inset by
  // 0.15em while the CSS drew at 0.35em, putting the clickable box ~3.2px right of
  // the drawn one: its left edge was dead, and a click just outside its right edge
  // toggled. Both are one pixel inside/outside the DRAWN box, so they fail against
  // the old geometry and pass against the shared constants.
  it('the drawn box\'s LEFT edge responds', () => {
    const { view, click } = setup()
    expect(click(boxLeft + 1, 18)).toBe(false) // consumed
    expect(view.state.doc.toString()).toBe('- [x] task')
    view.destroy()
  })

  it('just right of the drawn box does NOT toggle', () => {
    const { view, click } = setup()
    expect(click(boxRight + 1, 18)).toBe(true) // fell through
    expect(view.state.doc.toString()).toBe(LINE)
    view.destroy()
  })
})
