// GitHub-activity card — the concrete BaseCardNodeView for the
// `githubActivity` anchor node. The node carries only a `date`; this view
// reads events.db for that day and renders a live summary (commit/PR
// counts + a short list). It re-renders when the events store bumps
// (after a sync), so the card follows the data without reopening the note.
//
// Nothing here is written back to markdown — the file holds just the
// `<div data-github-activity="DATE">` anchor (see schema/github-activity-block.ts).

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { BaseCardNodeView } from './BaseCardNodeView'
import { eventsQueryByDate, type Entry } from '@/lib/eventsDb'
import { useEventsStore } from '@/state/eventsStore'

const MAX_ROWS = 8

class GitHubActivityCardNodeView extends BaseCardNodeView {
  private readonly container: HTMLElement
  private date: string
  /** Bumped per reload so a slow query for a stale date is discarded. */
  private seq = 0
  private unsub: (() => void) | null = null

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    super('github-activity', 'githubActivity', view, getPos)

    this.date = (node.attrs.date as string) ?? ''
    this.container = document.createElement('div')
    this.container.className =
      'github-activity-card rounded-lg border bg-muted/30 px-3 py-2 text-sm'
    this.mountBody(this.container)

    // Re-render whenever events.db may have changed.
    this.unsub = useEventsStore.subscribe(() => {
      void this.reload()
    })
    void this.reload()
  }

  protected renderBody(): HTMLElement {
    return this.container
  }

  protected updateBody(node: PMNode): boolean {
    const next = (node.attrs.date as string) ?? ''
    if (next !== this.date) {
      this.date = next
      void this.reload()
    }
    return true
  }

  private async reload(): Promise<void> {
    const seq = ++this.seq
    const date = this.date
    let entries: Entry[] = []
    try {
      entries = await eventsQueryByDate(date)
    } catch (err) {
      console.warn('[github-activity-card] query failed', err)
    }
    // A newer reload (or a date change) started while we awaited — drop this.
    if (seq !== this.seq) return
    this.render(date, entries)
  }

  private render(date: string, entries: Entry[]): void {
    const commits = entries.filter((e) => e.kind === 'commit')
    const opened = entries.filter((e) => e.kind === 'pr_opened')
    const merged = entries.filter((e) => e.kind === 'pr_merged')

    this.container.replaceChildren()

    const header = document.createElement('div')
    header.className = 'flex items-center gap-2 font-medium'
    header.textContent = `GitHub · ${date}`
    this.container.appendChild(header)

    const counts = document.createElement('div')
    counts.className = 'mt-0.5 text-xs text-muted-foreground'
    if (entries.length === 0) {
      counts.textContent = 'No activity'
    } else {
      counts.textContent =
        `${commits.length} commit${commits.length === 1 ? '' : 's'}` +
        ` · ${opened.length} opened · ${merged.length} merged`
    }
    this.container.appendChild(counts)

    if (entries.length === 0) return

    const list = document.createElement('ul')
    list.className = 'mt-1.5 space-y-0.5'
    // commits first, then PRs; cap the visible rows.
    const rows = [...commits, ...opened, ...merged].slice(0, MAX_ROWS)
    for (const e of rows) {
      const li = document.createElement('li')
      li.className = 'flex gap-1.5 text-xs'
      const tag = document.createElement('span')
      tag.className = 'shrink-0 text-muted-foreground'
      tag.textContent =
        e.kind === 'commit' ? '·' : e.kind === 'pr_merged' ? 'merged' : 'PR'
      const text = document.createElement('span')
      text.className = 'truncate'
      text.textContent = e.summary
      li.append(tag, text)
      list.appendChild(li)
    }
    this.container.appendChild(list)

    const hidden = entries.length - rows.length
    if (hidden > 0) {
      const more = document.createElement('div')
      more.className = 'mt-1 text-xs text-muted-foreground'
      more.textContent = `+${hidden} more`
      this.container.appendChild(more)
    }
  }

  override destroy(): void {
    this.unsub?.()
    this.unsub = null
    super.destroy()
  }
}

export const githubActivityNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          githubActivity: (node, view, getPos) =>
            new GitHubActivityCardNodeView(node, view, getPos),
        },
      },
    }),
)
