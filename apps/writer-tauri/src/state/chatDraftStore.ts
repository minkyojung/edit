// Per-thread composer draft (unsent input) — memory only.
//
// Why this exists:
//   The chat composer's unsent state (draft text, attachments, pasted
//   text, @-mentions) used to live in PromptInput's local `useState`.
//   Because the composer is never remounted on thread switch (no
//   `key={activeId}`), that state bled across sessions: attach an image
//   in thread A, switch to B, and the chip followed you.
//
//   The fix is to scope the draft to the thread, the same way the app
//   already scopes per-thread model / effort / mode. This mirrors the
//   ephemeral per-thread stores (contextUsageStore, fastModeStore):
//   a zustand Map keyed by threadId, NOT the disk-backed ThreadMeta —
//   draft text changes on every keystroke, and ThreadMeta.updateMeta
//   writes a file per mutation, so persisting the draft there would
//   thrash the disk. Draft is deliberately memory-only; it does not
//   survive an app restart (the attached bytes already live on disk
//   under `.octave/attachments/`, but the composer state is transient).

import { create } from 'zustand'
import type { FileAttachment } from '@/chat/types'
import type { MentionItem } from '@/chat/MentionPalette'

export interface PastedText {
  id: string
  preview: string
  content: string
}

export interface ChatDraft {
  text: string
  attachments: FileAttachment[]
  pastedTexts: PastedText[]
  mentions: MentionItem[]
}

/** Shared stable reference for an absent draft. Selecting this (rather
 * than a fresh literal) keeps PromptInput from re-rendering on every
 * store change while its thread has no draft yet. */
export const EMPTY_DRAFT: ChatDraft = {
  text: '',
  attachments: [],
  pastedTexts: [],
  mentions: [],
}

interface ChatDraftState {
  drafts: Record<string, ChatDraft>
  /** The draft for a thread, or the shared EMPTY_DRAFT when none exists. */
  get: (threadId: string) => ChatDraft
  /** Merge a partial update over the thread's draft (creating it from
   * EMPTY_DRAFT on first write). */
  patch: (threadId: string, patch: Partial<ChatDraft>) => void
  /** Drop a thread's draft — called on successful submit. */
  clear: (threadId: string) => void
  /** Drop a thread's draft — called when the thread is deleted. Same
   * effect as clear(); kept separate so the two call sites read by intent. */
  remove: (threadId: string) => void
}

export const useChatDraftStore = create<ChatDraftState>((set, get) => ({
  drafts: {},
  get: (id) => get().drafts[id] ?? EMPTY_DRAFT,
  patch: (id, patch) =>
    set((s) => ({
      drafts: { ...s.drafts, [id]: { ...(s.drafts[id] ?? EMPTY_DRAFT), ...patch } },
    })),
  clear: (id) =>
    set((s) => {
      if (!s.drafts[id]) return s
      const drafts = { ...s.drafts }
      delete drafts[id]
      return { drafts }
    }),
  remove: (id) =>
    set((s) => {
      if (!s.drafts[id]) return s
      const drafts = { ...s.drafts }
      delete drafts[id]
      return { drafts }
    }),
}))
