// Dev-only caret instrument. Run `__caret()` in the DevTools console while
// an editor is focused: it walks the active doc, asks ProseMirror for the
// caret coords at one position per visual line, and prints a table of
// `top` / `caretHeight` / `left` per line.
//
// NOTE: `coordsAtPos` reports the TEXT box (font ascent+descent), not the
// painted caret. On macOS WebKit the native caret is the full line-box height
// by design, which is why we hide it and draw our own (see
// editor/customCaretPlugin.ts). So this tool measures the text geometry the
// custom caret is built from — handy for sanity-checking line metrics, not the
// painted caret itself.

import { useEditorViewStore } from '@/state/editorViewStore'

if (import.meta.env.DEV) {
  ;(window as unknown as { __caret: () => unknown }).__caret = () => {
    const view = useEditorViewStore.getState().view
    if (!view) {
      console.warn('[caret] no active editor view — click into the editor first')
      return
    }
    const size = view.state.doc.content.size
    const rows: { line: number; top: number; caretHeight: number; left: number }[] = []
    let line = 0
    for (let p = 1; p < size; p++) {
      let c: { top: number; bottom: number; left: number }
      try {
        c = view.coordsAtPos(p)
      } catch {
        continue
      }
      // One row per visual line: skip positions whose top matches the
      // previous row (same line, scanning left→right).
      if (rows.length && Math.abs(rows[rows.length - 1].top - c.top) < 1.5) continue
      rows.push({
        line: line++,
        top: Math.round(c.top * 100) / 100,
        caretHeight: Math.round((c.bottom - c.top) * 100) / 100,
        left: Math.round(c.left),
      })
    }
    console.table(rows)
    const heights = rows.map((r) => r.caretHeight)
    console.log(
      `[caret] ${rows.length} lines · height min ${Math.min(...heights)} / max ${Math.max(...heights)}`,
    )
    return rows
  }
}
