import React from 'react'
import { IconBook2, IconLoader2 } from '@tabler/icons-react'
import { runChatToWikiHandoff } from '@/agent/wikiHandoff'
import { notify } from '@/lib/notify'

/** "File this reply into the wiki" action for an assistant turn. Hands
 * the message body off to the ingest engine via {@link runChatToWikiHandoff}
 * and surfaces the outcome through {@link notify}. Closes the
 * Karpathy bidirectional loop — chat answers can now compound back
 * into the wiki instead of disappearing.
 *
 * Disabled while the request is in flight (single-flight per button —
 * the loading spinner gates re-clicks). The wiki page itself doesn't
 * update here; the user reviews the queued proposals through the
 * existing WikiPageBanner flow. */
export function FileToWikiButton({
  text,
  threadId,
  threadTitle,
}: {
  text: string
  threadId: string
  threadTitle: string
}) {
  const [busy, setBusy] = React.useState(false)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const result = await runChatToWikiHandoff({
        messageContent: text,
        threadId,
        threadTitle,
      })
      // The agent proposes edits into the approval queue; nothing is written
      // until the user Keeps. editCount is how many proposals it staged.
      if (!result || result.editCount === 0) {
        notify.chatHandoffEmpty()
      } else {
        notify.chatHandoffQueued({ count: result.editCount })
      }
    } catch (err) {
      console.warn('[wikiHandoff] failed', err)
      notify.chatHandoffFailed()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="File reply into wiki"
      title={busy ? 'Filing…' : 'File reply into wiki'}
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70"
    >
      {busy ? (
        <IconLoader2 size={13} className="animate-spin" />
      ) : (
        <IconBook2 size={13} />
      )}
    </button>
  )
}
