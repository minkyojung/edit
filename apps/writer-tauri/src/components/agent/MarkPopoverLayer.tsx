// Listens for inline-mark clicks and shows a MarkPopover anchored to the
// clicked range. The popover reads its content from markStore (Y.Map-
// backed Mark domain object), not from PM mark.attrs.
//
// Why not PM mark.attrs: proof-sdk's proofComment schema only defines
// `id` and `by` as mark attrs (see proof-marks.ts:184-186). ProseMirror
// silently drops attrs not in the schema's declared list, so writing
// `text`/`quote`/`note` to mark.create({...}) doesn't persist them.
// markStore.get returns the full Mark, where `text` and `quote` are
// first-class fields — that's the single source of truth.
//
// Scope: this surface handles comments only. proofSuggestion marks
// surface via the hover bar (MarkHoverActionsLayer); a click-popover
// for suggestions would duplicate that.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { EditorView } from '@milkdown/kit/prose/view'
import { MarkPopover } from './MarkPopover'
import { MARK_CLICKED_EVENT, type MarkClickedDetail } from '@/editor/markClickPlugin'
import { acceptMark, rejectMark } from '@/editor/markActions'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { markStore } from '@/domain/markStoreInstance'
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
  const activeSlug = useActiveSlug()

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

  if (!active || !editorView || !activeSlug) return null

  // Read the domain Mark, not PM attrs. markStore returns null when
  // the mark id isn't in the store OR when the kind isn't comment —
  // either way we skip rendering (suggestion marks are owned by the
  // hover bar).
  const mark = markStore.get(activeSlug, active.markId)
  if (!mark || mark.kind !== 'comment') return null

  const proposal: Proposal = {
    kind: 'comment',
    quote: mark.quote,
    text: mark.text ?? '',
  }

  function close() {
    setActive(null)
  }

  function handleAccept() {
    if (!editorView || !ydoc || !active || !activeSlug) return
    void acceptMark(activeSlug, editorView, ydoc, active.markId)
    close()
  }

  function handleReject() {
    if (!editorView || !ydoc || !active || !activeSlug) return
    void rejectMark(activeSlug, editorView, active.markId)
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
