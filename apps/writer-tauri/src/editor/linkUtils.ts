// Shared helpers for link interaction code paths (Cmd+click, hover
// bar, etc.). Keeps the safe-scheme allowlist and the Tauri shell
// plumbing in one place so call sites don't drift.

import { open } from '@tauri-apps/plugin-shell'
import type { EditorView } from '@milkdown/kit/prose/view'

import { notify } from '@/lib/notify'

const SAFE_SCHEMES = ['http://', 'https://', 'mailto:']

export function isSafeUrl(href: string): boolean {
  const lower = href.toLowerCase().trim()
  return SAFE_SCHEMES.some((s) => lower.startsWith(s))
}

/** Open `href` in the system browser if its scheme is on the allow
 * list. Returns false when the URL is rejected (caller can decide
 * whether to fall through). Surfaces a toast on Tauri shell failure. */
export function openLinkSafely(href: string): boolean {
  if (!isSafeUrl(href)) return false
  void open(href).catch(() => {
    notify.linkOpenFailed()
  })
  return true
}

/** Replace the link mark on `range` with one pointing at `href`. An
 * empty `href` removes the mark entirely. Single transaction so undo
 * collapses replace-and-set into one step. */
export function applyLinkMark(
  view: EditorView,
  range: { from: number; to: number },
  href: string,
): void {
  const linkType = view.state.schema.marks.link
  if (!linkType) return
  const trimmed = href.trim()
  const tr = view.state.tr.removeMark(range.from, range.to, linkType)
  if (trimmed) {
    tr.addMark(range.from, range.to, linkType.create({ href: trimmed }))
  }
  view.dispatch(tr)
}

/** Walk outward from a rendered <a> element to find the PM range of
 * the link mark that produced it. Bounded by href identity so two
 * adjacent links with different URLs stay separate. */
export function getLinkRange(
  view: EditorView,
  anchor: HTMLAnchorElement,
): { from: number; to: number; href: string } | null {
  const linkType = view.state.schema.marks.link
  if (!linkType) return null

  const pos = view.posAtDOM(anchor, 0)
  if (pos < 0) return null

  const $pos = view.state.doc.resolve(pos)
  const after = $pos.nodeAfter
  if (!after) return null
  const mark = linkType.isInSet(after.marks)
  if (!mark) return null
  const href = mark.attrs.href as string

  let from = pos
  let $back = view.state.doc.resolve(from)
  while ($back.nodeBefore) {
    const m = linkType.isInSet($back.nodeBefore.marks)
    if (!m || m.attrs.href !== href) break
    from -= $back.nodeBefore.nodeSize
    $back = view.state.doc.resolve(from)
  }

  let to = pos
  let $fwd = view.state.doc.resolve(to)
  while ($fwd.nodeAfter) {
    const m = linkType.isInSet($fwd.nodeAfter.marks)
    if (!m || m.attrs.href !== href) break
    to += $fwd.nodeAfter.nodeSize
    $fwd = view.state.doc.resolve(to)
  }

  return { from, to, href }
}
