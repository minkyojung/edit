// Listens for inline-mark clicks and shows a MarkPopover anchored to the
// clicked range. Reads the current proposal shape from Y.Map so it works
// independently of whatever proposed it (chat history, manual mark, etc.).
//
// The diff itself is rendered inline in the document body (red strikethrough
// for the original + green ghost widget for the replacement), so the popover
// here only carries the action surface and any rationale/comment text.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import { MarkPopover } from './MarkPopover'
import { MARK_CLICKED_EVENT, type MarkClickedDetail } from '@/editor/markClickPlugin'
import { acceptMark, rejectMark } from '@/editor/markActions'
import { useMarks } from '@/hooks/useMarks'
import type { Proposal } from '@/agent/proposals'
import type { StoredMark } from '@/hooks/useCollabDoc'

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
      onAccept={handleAccept}
      onReject={handleReject}
      onClose={close}
    />
  )
}
