import { useState } from 'react'
import { proofClient } from '../lib/proofClient'
import type { SelectionInfo } from './selectionPlugin'
import { buildTextIndex, posToCharOffset } from './utils/textRange'

const DOC_SLUG_KEY = 'writer-tauri:doc-slug'

interface Props {
  selection: SelectionInfo | null
  onDismiss: () => void
}

type Mode = 'pick' | 'comment' | 'replace'

export function MarkToolbar({ selection, onDismiss }: Props) {
  const [mode, setMode] = useState<Mode>('pick')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  if (!selection) return null

  const slug = localStorage.getItem(DOC_SLUG_KEY)
  if (!slug) return null

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

  async function submit() {
    if (loading) return
    const anchors = computeAnchors()
    if (!anchors) {
      console.error('[mark] failed to compute anchors')
      return
    }
    setLoading(true)
    try {
      if (mode === 'comment') {
        await proofClient.createMark(slug!, 'comment.add', {
          by: 'owner',
          quote: selection!.text,
          text: input.trim() || '.',
          ...anchors,
        })
      } else if (mode === 'replace') {
        await proofClient.createMark(slug!, 'suggestion.add', {
          kind: 'replace',
          by: 'owner',
          quote: selection!.text,
          content: input.trim(),
          ...anchors,
        })
      }
      reset()
    } catch (err) {
      console.error('[mark] create failed', err)
      setLoading(false)
    }
  }

  async function createDelete() {
    if (!slug) return
    const anchors = computeAnchors()
    if (!anchors) {
      console.error('[mark] failed to compute anchors')
      return
    }
    setLoading(true)
    try {
      await proofClient.createMark(slug, 'suggestion.add', {
        kind: 'delete',
        by: 'owner',
        quote: selection!.text,
        ...anchors,
      })
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
            placeholder={mode === 'comment' ? '코멘트 입력…' : '대체할 텍스트…'}
            className="h-7 w-48 rounded border border-border bg-background px-2 text-xs outline-none"
          />
          <ToolbarBtn onClick={submit} disabled={loading || (mode === 'replace' && !input.trim())}>
            확인
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
