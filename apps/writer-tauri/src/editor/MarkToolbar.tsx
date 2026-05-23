/**
 * MarkToolbar — pops up over a non-empty text selection and lets the
 * user attach a comment, a replace suggestion, or a delete suggestion
 * to that range.
 *
 * Phase 2.5 — migrated off direct `Y.Map.set` + `tr.addMark` to
 * `markStore.add`. The previous direct-write path wrote marks in the
 * legacy `StoredMark` shape (with `char:N` relative positions in
 * `startRel`/`endRel`), which the new domain Mark schema's
 * `isValidMark` rejects — so user-created marks were silently
 * disappearing from the live UI after Phase 2.4 even though they
 * landed in Y.Map.
 *
 * markStore.add now anchors via y-prosemirror RelativePosition (the
 * proper CRDT-stable encoding), and we pass the exact selection range
 * as `anchor` so the mark always lands where the user selected — even
 * when the selected text appears multiple times in the doc.
 *
 * The ydoc prop is gone; markStore resolves the active doc internally
 * from `useDocsStore` + `useEditorViewStore`. Callers pass `slug`
 * instead so the store can match against `activeSlug`.
 */

import { useEffect, useState } from 'react'
import type { SelectionInfo } from './selectionPlugin'
import { notify } from '@/lib/notify'
import { markStore } from '@/domain/markStoreInstance'

interface Props {
  slug: string
  selection: SelectionInfo | null
  onDismiss: () => void
}

type Mode = 'pick' | 'comment' | 'replace'

export function MarkToolbar({ slug, selection, onDismiss }: Props) {
  const [mode, setMode] = useState<Mode>('pick')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  // Reset transient state whenever the selected range changes (or
  // clears). Standard product convention: an unsaved comment / replace
  // draft is discarded the moment the user moves to a different
  // anchor, so the next selection always opens in the neutral 'pick'
  // mode. Without this the toolbar's React instance stays mounted
  // (the parent always renders it while a doc is open), so `mode` and
  // `input` would carry over from the previous selection.
  //
  // The dependency is the (from, to) pair, not the SelectionInfo
  // object reference — the selectionPlugin emits a fresh object on
  // every dispatch (including no-op selection updates while typing
  // inside the composer input), so depending on the object would
  // wipe the user's in-progress typing mid-keystroke.
  useEffect(() => {
    setMode('pick')
    setInput('')
    setLoading(false)
  }, [selection?.from, selection?.to])

  // Global Escape — input's own keydown only fires while the input is
  // focused. Esc after clicking elsewhere (or just after clicking the
  // Comment button before focus settled) would otherwise leave the
  // composer half-open. A window-scoped listener catches both cases.
  // Bound only while the toolbar is showing so we don't shadow Esc
  // for anything else when the toolbar isn't visible.
  useEffect(() => {
    if (!selection) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMode('pick')
      setInput('')
      setLoading(false)
      onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, onDismiss])

  if (!selection) return null

  const style: React.CSSProperties = {
    position: 'fixed',
    top: selection.coords.top - 48,
    left: selection.coords.left,
    zIndex: 50,
  }

  function reset() {
    setMode('pick')
    setInput('')
    setLoading(false)
    onDismiss()
  }

  async function submit() {
    if (loading || !selection) return
    setLoading(true)
    try {
      const anchor = { from: selection.from, to: selection.to }
      const quote = selection.text

      const result = mode === 'comment'
        ? await markStore.add({
            slug,
            kind: 'comment',
            quote,
            anchor,
            text: input.trim() || '.',
            by: 'human:owner',
          })
        : await markStore.add({
            slug,
            kind: 'suggestion',
            suggestionType: 'replace',
            quote,
            anchor,
            content: input.trim(),
            by: 'human:owner',
          })

      if (!result.ok) {
        console.error('[mark] create failed', result.reason)
        notify.markCantAdd()
        setLoading(false)
        return
      }
      reset()
    } catch (err) {
      console.error('[mark] create failed', err)
      notify.markCantAdd()
      setLoading(false)
    }
  }

  async function createDelete() {
    if (!selection) return
    setLoading(true)
    try {
      const result = await markStore.add({
        slug,
        kind: 'suggestion',
        suggestionType: 'delete',
        quote: selection.text,
        anchor: { from: selection.from, to: selection.to },
        by: 'human:owner',
      })
      if (!result.ok) {
        console.error('[mark] create failed', result.reason)
        notify.markCantAdd()
        setLoading(false)
        return
      }
      reset()
    } catch (err) {
      console.error('[mark] create failed', err)
      notify.markCantAdd()
      setLoading(false)
    }
  }

  return (
    <div
      style={style}
      className="flex flex-col gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      {mode === 'pick' && (
        <div className="flex gap-1">
          <ToolbarBtn onClick={() => setMode('comment')}>💬 Comment</ToolbarBtn>
          <ToolbarBtn onClick={() => setMode('replace')}>✏️ Replace</ToolbarBtn>
          <ToolbarBtn onClick={createDelete} disabled={loading}>🗑️ Delete</ToolbarBtn>
        </div>
      )}

      {(mode === 'comment' || mode === 'replace') && (
        <div className="flex gap-1">
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') reset()
            }}
            placeholder={mode === 'comment' ? 'Add a comment…' : 'Replacement text…'}
            className="h-7 w-48 rounded border border-border bg-background px-2 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <ToolbarBtn onClick={submit} disabled={loading || (mode === 'replace' && !input.trim())}>
            Confirm
          </ToolbarBtn>
          <ToolbarBtn onClick={reset}>✕</ToolbarBtn>
        </div>
      )}
    </div>
  )
}

function ToolbarBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2 py-1 text-xs text-foreground transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}
