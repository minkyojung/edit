import { useState } from 'react'
import * as Y from 'yjs'
import type { SelectionInfo } from './selectionPlugin'
import type { StoredMark } from '../hooks/useCollabDoc'
import { buildTextIndex, posToCharOffset } from './utils/textRange'

interface Props {
  selection: SelectionInfo | null
  ydoc: Y.Doc
  onDismiss: () => void
}

type Mode = 'pick' | 'comment' | 'replace'

export function MarkToolbar({ selection, ydoc, onDismiss }: Props) {
  const [mode, setMode] = useState<Mode>('pick')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

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

  function computeAnchors(): { startRel: string; endRel: string } | null {
    const index = buildTextIndex(selection!.doc)
    if (!index) return null
    // PM 'from' = position OF first char (in positions array)
    const startChar = posToCharOffset(index, selection!.from)
    // PM 'to' = position AFTER last char (not in array). Look up last char, add 1.
    const lastCharIdx = posToCharOffset(index, selection!.to - 1)
    if (startChar === null || lastCharIdx === null) return null
    return { startRel: `char:${startChar}`, endRel: `char:${lastCharIdx + 1}` }
  }

  function stampInlineMark(
    markId: string,
    kind: 'replace' | 'insert' | 'delete' | 'comment',
    extraAttrs: Record<string, unknown> = {},
  ): boolean {
    const view = selection!.view
    const schemaName = kind === 'comment' ? 'proofComment' : 'proofSuggestion'
    const markType = view.state.schema.marks[schemaName]
    if (!markType) {
      console.error(`[mark] schema mark "${schemaName}" not found`)
      return false
    }
    const attrs = kind === 'comment'
      ? { id: markId, by: 'owner' }
      : { id: markId, kind, by: 'owner', ...extraAttrs }
    view.dispatch(view.state.tr.addMark(selection!.from, selection!.to, markType.create(attrs)))
    return true
  }

  function writeMarkToYMap(markId: string, mark: StoredMark) {
    const marksMap = ydoc.getMap<StoredMark>('marks')
    marksMap.set(markId, mark)
  }

  function submit() {
    if (loading) return
    const anchors = computeAnchors()
    if (!anchors) {
      console.error('[mark] failed to compute anchors')
      return
    }
    const markId = crypto.randomUUID()
    const now = new Date().toISOString()
    setLoading(true)
    try {
      if (mode === 'comment') {
        if (!stampInlineMark(markId, 'comment')) { setLoading(false); return }
        writeMarkToYMap(markId, {
          kind: 'comment',
          by: 'owner',
          quote: selection!.text,
          text: input.trim() || '.',
          ...anchors,
          at: now,
        } as StoredMark)
      } else if (mode === 'replace') {
        const content = input.trim()
        if (!stampInlineMark(markId, 'replace', { content })) { setLoading(false); return }
        writeMarkToYMap(markId, {
          kind: 'replace',
          by: 'owner',
          quote: selection!.text,
          content,
          status: 'pending',
          ...anchors,
          at: now,
        } as StoredMark)
      }
      reset()
    } catch (err) {
      console.error('[mark] create failed', err)
      setLoading(false)
    }
  }

  function createDelete() {
    const anchors = computeAnchors()
    if (!anchors) {
      console.error('[mark] failed to compute anchors')
      return
    }
    const markId = crypto.randomUUID()
    const now = new Date().toISOString()
    setLoading(true)
    try {
      if (!stampInlineMark(markId, 'delete')) { setLoading(false); return }
      writeMarkToYMap(markId, {
        kind: 'delete',
        by: 'owner',
        quote: selection!.text,
        status: 'pending',
        ...anchors,
        at: now,
      } as StoredMark)
      reset()
    } catch (err) {
      console.error('[mark] create failed', err)
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
            className="h-7 w-48 rounded border border-border bg-background px-2 text-xs outline-none"
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
      className="rounded px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-40"
    >
      {children}
    </button>
  )
}
