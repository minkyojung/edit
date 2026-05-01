// Listens for inline-mark clicks and shows a MarkPopover anchored to the
// clicked range. Reads the current proposal shape from Y.Map so it works
// independently of whatever proposed it (chat history, manual mark, etc.).

import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import { MarkPopover, type Preview } from './MarkPopover'
import { MARK_CLICKED_EVENT, type MarkClickedDetail } from '@/editor/markClickPlugin'
import { acceptMark, rejectMark } from '@/editor/markActions'
import { useMarks } from '@/hooks/useMarks'
import { usePmDocVersion } from '@/hooks/usePmDocVersion'
import type { Proposal } from '@/agent/proposals'
import type { StoredMark } from '@/hooks/useCollabDoc'

const CONTEXT_CHARS = 15

/** Walk forward from start until we cross a whitespace boundary; return the
 *  first non-whitespace position after that. Used to trim partial words on
 *  the LEFT edge of a context window. */
function snapLeftToWordStart(text: string, start: number, end: number): number {
  let i = start
  while (i < end && !/\s/.test(text[i] ?? '')) i++
  while (i < end && /\s/.test(text[i] ?? '')) i++
  return i
}

/** Walk backward from end until we cross a whitespace boundary; return the
 *  last non-whitespace position before that. Used to trim partial words on
 *  the RIGHT edge. */
function snapRightToWordEnd(text: string, start: number, end: number): number {
  let i = end
  while (i > start && !/\s/.test(text[i - 1] ?? '')) i--
  while (i > start && /\s/.test(text[i - 1] ?? '')) i--
  return i
}

function buildPreview(view: EditorView, markId: string, stored: StoredMark): Preview | null {
  // Locate the inline mark range in the live doc.
  let from = -1
  let to = -1
  view.state.doc.descendants((node, pos) => {
    if (from !== -1) return false
    if (!node.isText) return
    for (const m of node.marks) {
      if (m.attrs.id === markId) {
        from = pos
        to = pos + node.nodeSize
        return false
      }
    }
  })
  if (from === -1) return null

  const fullText = view.state.doc.textBetween(0, view.state.doc.content.size, ' ')
  // Map doc positions to plain text indices: textBetween with a single space
  // separator means each PM char ≈ one text char for inline content; that's
  // good enough for the context window since we only need a rough slice.
  const docFrom = Math.max(0, view.state.doc.textBetween(0, from, ' ').length)
  const docTo = Math.max(docFrom, view.state.doc.textBetween(0, to, ' ').length)

  const leftStart = snapLeftToWordStart(fullText, Math.max(0, docFrom - CONTEXT_CHARS), docFrom)
  const rightEnd = snapRightToWordEnd(fullText, docTo, Math.min(fullText.length, docTo + CONTEXT_CHARS))

  const left = fullText.slice(leftStart, docFrom)
  const right = fullText.slice(docTo, rightEnd)

  if (stored.kind === 'replace' || stored.kind === 'insert') {
    return { left, middle: stored.content ?? '', right, mode: 'add' }
  }
  if (stored.kind === 'delete') {
    return { left, middle: stored.quote ?? '', right, mode: 'remove' }
  }
  return null
}

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
}

interface Active {
  markId: string
  rect: DOMRect
}

function storedMarkToProposal(stored: StoredMark): Proposal | null {
  if (stored.kind === 'comment') {
    return {
      kind: 'comment',
      quote: stored.quote ?? '',
      text: stored.text ?? '',
      rationale: stored.note,
    }
  }
  if (stored.kind === 'replace' || stored.kind === 'insert' || stored.kind === 'delete') {
    return {
      kind: 'suggestion',
      suggestionType: stored.kind,
      quote: stored.quote ?? '',
      content: stored.content,
      rationale: stored.note,
    }
  }
  return null
}

export function MarkPopoverLayer({ editorView, ydoc }: Props) {
  const [active, setActive] = useState<Active | null>(null)
  const marks = useMarks(ydoc)
  const docVersion = usePmDocVersion()

  useEffect(() => {
    function onClicked(e: Event) {
      const ce = e as CustomEvent<MarkClickedDetail>
      const detail = ce.detail
      if (!detail) return
      const rect = new DOMRect(detail.rect.left, detail.rect.top, detail.rect.width, detail.rect.height)
      setActive({ markId: detail.markId, rect })
    }
    window.addEventListener(MARK_CLICKED_EVENT, onClicked)
    return () => window.removeEventListener(MARK_CLICKED_EVENT, onClicked)
  }, [])

  // Recompute preview whenever the doc version bumps so the surrounding
  // context reflects edits made while the popover is open.
  const preview = useMemo<Preview | null>(() => {
    if (!editorView || !active) return null
    const stored = marks[active.markId]
    if (!stored) return null
    return buildPreview(editorView, active.markId, stored)
    // docVersion is the dependency that drives re-derivation; the value
    // itself is unused beyond invalidating the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorView, active, marks, docVersion])

  if (!active) return null
  const stored = marks[active.markId]
  if (!stored) return null
  const proposal = storedMarkToProposal(stored)
  if (!proposal) return null

  function close() {
    setActive(null)
  }

  function handleAccept() {
    if (!editorView || !ydoc || !active) return
    acceptMark(editorView, ydoc, active.markId)
    close()
  }

  function handleReject() {
    if (!editorView || !ydoc || !active) return
    rejectMark(editorView, ydoc, active.markId)
    close()
  }

  return (
    <MarkPopover
      open
      rect={active.rect}
      proposal={proposal}
      preview={preview}
      onAccept={handleAccept}
      onReject={handleReject}
      onClose={close}
    />
  )
}
