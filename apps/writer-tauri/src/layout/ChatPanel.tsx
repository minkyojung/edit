// Conversation surface on the right.
//
// Per-document, multi-thread (max 5 active). Each thread persists as a
// Y.Array on the document's Y.Doc, so thread + turn state survives
// reloads and syncs across devices.
//
// Per-proposal accept/reject lives in MarkPopover (anchored to the inline
// mark in the editor body). This panel is the transcript surface only:
// "Run Review" appends a user/assistant pair to the active thread, and
// the user is directed back to the body to act on individual highlights.

import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useThreads } from '@/hooks/useThreads'
import { useThreadTurns } from '@/hooks/useThreadTurns'
import { useActiveThread } from '@/hooks/useActiveThread'
import { runReview } from '@/agent/runReview'
import { ThreadTabs } from '@/chat/ThreadTabs'
import type { ChatTurn } from '@/chat/types'

interface Props {
  editorView: EditorView | null
  ydoc: Y.Doc | null
  provider: HocuspocusProvider | null
  slug: string | null
}

export function ChatPanel({ editorView, ydoc, provider, slug }: Props) {
  const { account } = useClaudeAuth()
  const threads = useThreads(ydoc)
  const { activeId, setActiveId } = useActiveThread(slug, threads.active)
  const turnsHook = useThreadTurns(ydoc, activeId)
  const bottomRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef(false)

  // Track Hocuspocus initial sync so we don't auto-create a thread before the
  // server has had a chance to send us the existing list — that race produces
  // duplicate threads on every reload.
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    setSynced(false)
    if (!provider) return
    if (provider.synced) {
      setSynced(true)
      return
    }
    const onSynced = () => setSynced(true)
    provider.on('synced', onSynced)
    return () => {
      provider.off('synced', onSynced)
    }
  }, [provider])

  // Auto-create the first thread only after we've synced — and only if the
  // document genuinely has none.
  useEffect(() => {
    if (!synced || !threads.ready) return
    if (threads.threads.length === 0) {
      threads.createThread()
    }
  }, [synced, threads])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turnsHook.turns])

  const ready = !!editorView && !!ydoc && !!activeId

  async function handleReview() {
    if (!ready || runningRef.current) return
    runningRef.current = true

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Run review on this document.',
      ts: Date.now(),
    }
    turnsHook.appendTurn(userTurn)

    try {
      const result = await runReview(editorView!, ydoc!)
      const summary =
        result.proposed === 0
          ? 'No issues to flag — looks clean to me.'
          : `Found **${result.applied.length}** issue${result.applied.length === 1 ? '' : 's'} — click any highlight in the document to review.`
      turnsHook.appendTurn({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: summary,
        ts: Date.now(),
      })
    } catch (e) {
      turnsHook.appendTurn({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `**Review failed.** ${String(e)}`,
        ts: Date.now(),
      })
    } finally {
      runningRef.current = false
    }
  }

  return (
    <div className="relative flex h-full flex-col border-l border-border bg-background">
      {!account.connected && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 backdrop-blur-[2px] bg-background/60">
          <p className="text-sm text-muted-foreground text-center px-4">
            Connect to Claude<br />to start chatting
          </p>
        </div>
      )}

      <ThreadTabs
        active={threads.active}
        archived={threads.archived}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={() => {
          const id = threads.createThread()
          if (id) setActiveId(id)
        }}
        onArchive={(id) => {
          threads.archiveThread(id)
          // Active thread reconciles in useActiveThread when active list shifts.
        }}
        onRename={threads.renameThread}
        onRestore={(id) => {
          const r = threads.restoreThread(id)
          if (r.ok) setActiveId(id)
          return r
        }}
        onRestoreLimitReached={() => {
          // TODO: replace with a real toast once we add a toaster.
          console.warn('[threads] cannot restore — active limit reached')
        }}
      />

      <div className="flex-1 overflow-y-auto p-3 space-y-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {turnsHook.turns.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">
            Run a review to see results here
          </p>
        )}
        {turnsHook.turns.map((turn) => (
          <MessageRow key={turn.id} turn={turn} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <Button
          className="w-full"
          disabled={!ready || !account.connected}
          onClick={handleReview}
        >
          Run Review
        </Button>
      </div>
    </div>
  )
}

const markdownComponents: React.ComponentProps<typeof Markdown>['components'] = {
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="bg-muted text-foreground text-xs rounded px-1 py-0.5 font-mono">{children}</code>
  ),
}

function MessageRow({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm">{turn.content}</div>
      </div>
    )
  }
  return (
    <div className="text-sm text-foreground leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {turn.content}
      </Markdown>
    </div>
  )
}
