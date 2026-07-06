// "Version" settings panel — a read-only window into how the vault is
// checkpointed. Every AI action (and the user's own saves) lands as a git
// commit; this lists the recent ones so the user can SEE the format and confirm
// the reversibility floor is working. No actions here yet — purely a viewer.

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  gitLogSinceRef,
  gitShow,
  type CommitInfo,
  type CommitDetail,
  type DiffLine,
} from '@/lib/git'

/** How a commit subject maps to a human label + tone. AI checkpoints carry an
 * `(ai)` scope right after the type; the user's own saves are a bare `edit:`. */
function classify(subject: string): { label: string; tone: string; detail: string } {
  const ai = subject.match(/^([a-z]+)\(ai\):?\s*(.*)$/)
  if (ai) {
    const [, type, rest] = ai
    const labels: Record<string, string> = {
      edit: 'AI edit',
      organize: 'AI organize',
      ingest: 'AI ingest',
      revert: 'AI undo',
    }
    return {
      label: labels[type] ?? `AI ${type}`,
      tone: type === 'revert' ? 'text-amber-500' : 'text-sky-500',
      detail: rest.trim(),
    }
  }
  const user = subject.match(/^edit:\s*(.*)$/)
  if (user) return { label: 'You saved', tone: 'text-emerald-500', detail: user[1].trim() }
  return { label: 'change', tone: 'text-muted-foreground', detail: subject }
}

/** Pair a unified diff's lines into side-by-side rows: removed on the left, added
 * on the right. Within a change block (removes then adds, since diffs use
 * `--unified=0`) the i-th remove aligns with the i-th add; extra lines on either
 * side get an empty cell opposite them. */
function pairRows(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = []
  let removes: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = () => {
    const n = Math.max(removes.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: removes[i] ?? null, right: adds[i] ?? null })
    removes = []
    adds = []
  }
  for (const ln of lines) {
    if (ln.kind === 'remove') {
      if (adds.length) flush() // adds ended the previous block
      removes.push(ln)
    } else if (ln.kind === 'add') {
      adds.push(ln)
    } else {
      flush()
      rows.push({ left: ln, right: ln }) // context (rare — --unified=0)
    }
  }
  flush()
  return rows
}

/** Compact relative time from a unix-seconds timestamp. */
function relTime(unixSeconds: number, now: number): string {
  const s = Math.max(0, Math.floor(now / 1000) - unixSeconds)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function VersionSettings() {
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  // sha → detail. Absent key = not fetched; `null` = fetch failed.
  const [details, setDetails] = useState<Record<string, CommitDetail | null>>({})
  const now = Date.now()

  async function toggle(sha: string) {
    if (expanded === sha) {
      setExpanded(null)
      return
    }
    setExpanded(sha)
    if (!(sha in details)) {
      const d = await gitShow(sha)
      setDetails((m) => ({ ...m, [sha]: d }))
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Last ~30 commits; on a short-history vault `HEAD~30` doesn't resolve
      // (returns []), so fall back to everything since the last-reviewed mark.
      let list = await gitLogSinceRef('HEAD~30')
      if (list.length === 0) list = await gitLogSinceRef()
      if (!cancelled) setCommits(list.slice(0, 30))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">Version</h2>
      <p className="mb-4 text-footnote text-muted-foreground">
        Every AI action is saved as a checkpoint you can undo, and your own edits are
        snapshotted too. This is the recent history — the reversibility floor behind
        &ldquo;undo that&rdquo;.
      </p>

      {commits === null && (
        <p className="text-footnote text-muted-foreground">Loading…</p>
      )}
      {commits !== null && commits.length === 0 && (
        <p className="text-footnote text-muted-foreground">
          No checkpoints yet — they&rsquo;ll appear here as the AI edits your vault.
        </p>
      )}

      <ul className="space-y-0.5">
        {commits?.map((c) => {
          const { label, tone, detail } = classify(c.subject)
          const isOpen = expanded === c.sha
          const d = details[c.sha]
          // When the subject names no pages (bare `organize(ai)`), fall back to
          // the changed file paths so the row still says WHAT was touched.
          const paths = c.files.map((f) => f.path)
          const summary =
            detail ||
            (paths.length
              ? paths.slice(0, 2).join(', ') +
                (paths.length > 2 ? ` +${paths.length - 2}` : '')
              : '')
          return (
            <li key={c.sha}>
              <button
                type="button"
                onClick={() => void toggle(c.sha)}
                className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/40"
              >
                <span className={`w-24 shrink-0 text-footnote font-medium ${tone}`}>{label}</span>
                <span className="min-w-0 flex-1 truncate text-footnote text-foreground">
                  {summary || <span className="text-muted-foreground">(no detail)</span>}
                  {c.files.length > 0 && (
                    <span className="ml-2 text-muted-foreground">
                      · {c.files.length} file{c.files.length === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-caption text-muted-foreground">
                  {c.sha.slice(0, 7)}
                </span>
                <span className="w-16 shrink-0 text-right text-caption text-muted-foreground">
                  {relTime(c.timestamp, now)}
                </span>
              </button>

              {isOpen && (
                <div className="mb-1 ml-2 mt-0.5 border-l border-border pl-3">
                  {!(c.sha in details) && (
                    <p className="py-1 text-caption text-muted-foreground">Loading diff…</p>
                  )}
                  {d === null && (
                    <p className="py-1 text-caption text-muted-foreground">
                      Couldn&rsquo;t load the diff.
                    </p>
                  )}
                  {d?.body && (
                    <p className="mb-2 whitespace-pre-wrap text-footnote leading-snug text-muted-foreground">
                      {d.body}
                    </p>
                  )}
                  {d && d.files.length === 0 && (
                    <p className="py-1 text-caption text-muted-foreground">
                      No file changes (metadata only).
                    </p>
                  )}
                  {d?.files.map((f) => {
                    const rows = pairRows(f.lines)
                    const shown = rows.slice(0, 80)
                    return (
                      <div key={f.path} className="mb-2">
                        <div className="font-mono text-caption text-muted-foreground">
                          <span className="mr-1 uppercase">{f.status}</span>
                          {f.path}
                        </div>
                        <div className="mt-0.5 overflow-hidden rounded border border-border font-mono text-caption leading-snug">
                          {shown.map((r, i) => (
                            <div key={i} className="grid grid-cols-2">
                              <div
                                className={cn(
                                  'min-w-0 whitespace-pre-wrap break-words border-r border-border px-2 py-px',
                                  r.left ? 'bg-rose-500/10 text-rose-400' : 'bg-muted/10',
                                )}
                              >
                                {r.left?.text}
                              </div>
                              <div
                                className={cn(
                                  'min-w-0 whitespace-pre-wrap break-words px-2 py-px',
                                  r.right ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted/10',
                                )}
                              >
                                {r.right?.text}
                              </div>
                            </div>
                          ))}
                          {rows.length > 80 && (
                            <div className="px-2 py-px text-muted-foreground">
                              … {rows.length - 80} more rows
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
