// GitHub-activity card — the concrete BaseCardNodeView for the
// `githubActivity` anchor node. The node carries only a `date`; this view
// reads events.db for that day and renders a LIVE Vega-Lite chart:
//
//   GitHub · 2026-06-03 · 8 commits · 1 PR merged   ← readable header / fallback
//   ▭▭▭ hour-of-day stacked bar (commit/PR) ▭▭▭     ← VegaBlock (live)
//
// The chart's shape is a fixed spec (viz/specs/githubDailySpec); only the
// data changes — events.db rows are re-fed on every sync (eventsStore bump).
// This is the "fixed frame, live data" model (Vega keeps spec + data
// separate), and the first reuse of the viz family inside a data card.
//
// Nothing here is written to markdown — the file holds only the
// ```github-activity fence (see schema/github-activity-block.ts).

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { BaseCardNodeView } from './BaseCardNodeView'
import { eventsQueryByDate, type Entry } from '@/lib/eventsDb'
import { useEventsStore } from '@/state/eventsStore'
import { VegaBlock } from '@/viz/VegaBlock'
import { githubDailySpec } from '@/viz/specs/githubDailySpec'

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text != null) node.textContent = text
  return node
}

function isMergeCommit(summary: string): boolean {
  return /^Merge (pull request|branch|remote)/i.test(summary)
}

class GitHubActivityCardNodeView extends BaseCardNodeView {
  private readonly container: HTMLElement
  private readonly header: HTMLElement
  private readonly chartHost: HTMLElement
  private root: Root | null
  private date: string
  private seq = 0
  private unsub: (() => void) | null = null

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    super('github-activity', 'githubActivity', view, getPos)

    this.date = (node.attrs.date as string) ?? ''
    this.container = el(
      'div',
      'github-activity-card-body rounded-lg border bg-muted/20 px-3 py-2.5',
    )
    this.header = el('div', 'flex flex-wrap items-baseline gap-x-2 text-xs')
    this.chartHost = el('div', 'w-full')
    this.container.append(this.header, this.chartHost)
    this.root = createRoot(this.chartHost)
    this.mountBody(this.container)

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
    let entries: Entry[] = []
    try {
      entries = await eventsQueryByDate(this.date)
    } catch (err) {
      console.warn('[github-activity-card] query failed', err)
    }
    if (seq !== this.seq) return
    this.renderHeader(entries)
    this.renderChart(entries)
  }

  private renderHeader(entries: Entry[]): void {
    const commits = entries.filter(
      (e) => e.kind === 'commit' && !isMergeCommit(e.summary),
    )
    const merged = entries.filter((e) => e.kind === 'pr_merged')
    const opened = entries.filter((e) => e.kind === 'pr_opened')

    const parts: string[] = []
    if (commits.length)
      parts.push(`${commits.length} commit${commits.length > 1 ? 's' : ''}`)
    if (merged.length) parts.push(`${merged.length} PR merged`)
    if (opened.length) parts.push(`${opened.length} PR opened`)

    this.header.replaceChildren(
      el('span', 'font-medium text-foreground', 'GitHub'),
      el('span', 'text-muted-foreground/50', this.date),
      el(
        'span',
        'text-muted-foreground',
        parts.length ? parts.join(' · ') : 'No activity',
      ),
    )
  }

  private renderChart(entries: Entry[]): void {
    if (!this.root) return
    if (entries.length === 0) {
      this.root.render(null)
      return
    }
    // Rows for the spec: one per event, bucketed by local hour. Vega
    // aggregates the count; `kind` drives the stacked colour.
    const rows = entries
      .map((e) => ({ hour: new Date(e.ts).getHours(), kind: e.kind }))
      .filter((r) => !Number.isNaN(r.hour))
    this.root.render(
      createElement(VegaBlock, { spec: githubDailySpec, data: rows }),
    )
  }

  override destroy(): void {
    this.unsub?.()
    this.unsub = null
    const root = this.root
    this.root = null
    if (root) {
      // Defer so we don't unmount synchronously inside a PM update tick.
      queueMicrotask(() => root.unmount())
    }
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
