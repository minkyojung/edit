// Listens for inline-mark clicks and shows a MarkPopover anchored to the
// clicked range. Reads the current proposal shape from Y.Map so it works
// independently of whatever proposed it (chat history, manual mark, etc.).
//
// Scope: this surface now handles **comments only**. proofSuggestion marks
// (replace / insert / delete) carry their rationale + Keep/Reject inside
// the hover-driven floating bar (MarkHoverActionsLayer); rendering the
// popover for them too would duplicate the action UI on a single click.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import { MarkPopover } from './MarkPopover'
import { MARK_CLICKED_EVENT, type MarkClickedDetail } from '@/editor/markClickPlugin'
import { acceptMark, getProofCommentMark, rejectMark } from '@/editor/markActions'
import { useDocsStore } from '@/state/docsStore'
import type { Proposal } from '@/agent/proposals'

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
}

interface Active {
  markId: string
  rect: DOMRect
}

export function MarkPopoverLayer({ editorView, ydoc }: Props) {
  const [active, setActive] = useState<Active | null>(null)

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

  if (!active || !editorView) return null
  // Read body / quote / rationale straight off the PM mark. PM is the
  // single source of truth for whether the comment exists AND for its
  // contents — Cmd+Z after a resolve restores both atomically (no
  // dual-source race with Y.Map). Suggestions are intentionally not
  // handled here; the hover bar owns their surface.
  const mark = getProofCommentMark(editorView, active.markId)
  if (!mark) return null
  const proposal: Proposal = {
    kind: 'comment',
    quote: typeof mark.attrs.quote === 'string' ? mark.attrs.quote : '',
    text: typeof mark.attrs.text === 'string' ? mark.attrs.text : '',
    rationale: typeof mark.attrs.note === 'string' ? mark.attrs.note : undefined,
  }

  function close() {
    setActive(null)
  }

  function handleAccept() {
    if (!editorView || !ydoc || !active) return
    const slug = useDocsStore.getState().activeSlug
    if (!slug) return
    // Fire-and-forget: the server's ops call drives the state change;
    // local UI catches up via the WebSocket round-trip. Errors route
    // through notify.* inside acceptMark, so awaiting here would only
    // delay the popover close without changing the outcome.
    void acceptMark(slug, editorView, ydoc, active.markId)
    close()
  }

  function handleReject() {
    if (!editorView || !ydoc || !active) return
    const slug = useDocsStore.getState().activeSlug
    if (!slug) return
    void rejectMark(slug, editorView, active.markId)
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
