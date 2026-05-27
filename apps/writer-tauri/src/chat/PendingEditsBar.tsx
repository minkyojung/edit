// Sticky bar above the chat input that surfaces every write-side
// tool call the model attempted during this turn but is waiting on
// the user to Apply / Reject. The bar is the user-facing half of
// the canUseTool gate the sidecar installed in Phase 3.1 — until
// the user makes a decision the model's edit sits paused at the
// staged-edit boundary.
//
// Phase 3.3: clicking [Apply] / [Reject] now fires
// `claude_chat_edit_decision` back to the sidecar, which resolves
// the matching canUseTool Promise. Allow lets the SDK run the Edit
// (real fs.write); Reject feeds a "user rejected" message to the
// model so it can acknowledge and move on.

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { usePendingEditsStore, type PendingEdit } from '@/state/pendingEditsStore'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { getActiveVaultPath } from '@/state/settingsStore'
import { readVaultFile, vaultFileExists } from '@/lib/vault'
import { StreamingMarkdown } from '@/chat/ui/StreamingMarkdown'
import { cn } from '@/lib/utils'

export function PendingEditsBar() {
  // Subscribe to the stable `byId` map and derive the filtered list
  // via useMemo. Inlining the filter in the selector would return a
  // freshly-allocated array on every render, which zustand sees as
  // a "changed" value and re-renders again — infinite loop.
  const byId = usePendingEditsStore((s) => s.byId)
  const pendings = useMemo(
    () => Object.values(byId).filter((e) => e.status === 'pending'),
    [byId],
  )
  if (pendings.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {pendings.map((edit) => (
        <PendingEditCard key={edit.id} edit={edit} />
      ))}
    </div>
  )
}

function PendingEditCard({ edit }: { edit: PendingEdit }) {
  const markApplied = usePendingEditsStore((s) => s.markApplied)
  const markRejected = usePendingEditsStore((s) => s.markRejected)

  // Fire-and-forget decision relay — used only when the unified store
  // doesn't have an entry for this edit (mapping failed in
  // chat/index.ts: unknown tool, unmappable file path, etc.). When
  // the entry IS in the new store, the applier handles the sidecar
  // gate as a side effect of the status flip, so we route through
  // that path instead and the two stores stay in lockstep.
  const sendDecision = (decision: 'allow' | 'deny') => {
    invoke('claude_chat_edit_decision', {
      args: { runId: edit.runId, pendingId: edit.id, decision },
    }).catch((err) => {
      console.warn('[chat] edit-decision failed', err)
    })
  }
  const decide = (decision: 'allow' | 'deny') => {
    // pendingChangesStore is keyed by the same pendingId we mint in
    // chat/index.ts's listener (Phase E2). When the entry exists, it
    // is the source of truth — flipping its status fires the applier
    // subscriber, which sends the sidecar decision. Updating the
    // legacy store too keeps PendingEditsBar's local hide-on-decide
    // animation working during the transition.
    const inNewStore = !!usePendingChangesStore.getState().byId[edit.id]
    if (inNewStore) {
      if (decision === 'allow') usePendingChangesStore.getState().accept(edit.id)
      else usePendingChangesStore.getState().reject(edit.id)
    } else {
      // Fallback: the mapper couldn't translate this tool call into a
      // PendingChange (no slug match, unsupported tool). Use the legacy
      // direct-invoke path so the user still has a working decision.
      sendDecision(decision)
    }
  }
  const onApply = () => {
    markApplied(edit.id)
    decide('allow')
  }
  const onReject = () => {
    markRejected(edit.id)
    decide('deny')
  }

  const filePath = readString(edit.input.file_path)
  const oldString = readString(edit.input.old_string)
  const newString = readString(edit.input.new_string)

  const shortPath = useMemo(() => toVaultRelative(filePath), [filePath])

  // Pull the doc body off disk so the card can show the surrounding
  // lines as context — the model's `old_string` is often a tiny
  // anchor (e.g. just `<br />`) that doesn't include the sentence
  // the user thinks of as "around here". Reading the source file is
  // the only way to recover that orientation. Fails silently when
  // the file doesn't exist (Write tool / brand new wiki page) — we
  // fall back to a context-less diff in that case.
  const [fileText, setFileText] = useState<string | null>(null)
  useEffect(() => {
    if (!shortPath) return
    let cancelled = false
    void (async () => {
      try {
        const exists = await vaultFileExists(shortPath)
        if (!exists) return
        const text = await readVaultFile(shortPath)
        if (!cancelled) setFileText(text)
      } catch {
        // Disk read failures aren't fatal for the card — drop to the
        // no-context fallback.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [shortPath])

  const diff = useMemo(
    () => buildContextualDiff(fileText, oldString, newString),
    [fileText, oldString, newString],
  )

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
            {edit.toolName}
          </span>
          {shortPath && (
            <span className="truncate font-mono text-[11px]">{shortPath}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[12px]"
            onClick={onReject}
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="default"
            className="h-7 px-2 text-[12px]"
            onClick={onApply}
          >
            Apply
          </Button>
        </div>
      </div>
      {diff.length > 0 && (
        <div className="space-y-1">
          {diff.map((line, i) => (
            <Line key={i} kind={line.kind} text={line.text} />
          ))}
        </div>
      )}
    </div>
  )
}

type LineKind = 'add' | 'remove' | 'context'

/** Per-row strip color. Drawn as a 3px bar on the left so the user
 * can tell add / remove / context at a glance without reading. */
const KIND_BAR: Record<LineKind, string> = {
  add: 'bg-green-500',
  remove: 'bg-red-500',
  context: 'bg-muted-foreground/30',
}

/** Background tint for the row body. Subtle on add/remove so the
 * markdown rendering inside stays legible; context has no tint so
 * it visually recedes. */
const KIND_BG: Record<LineKind, string> = {
  add: 'bg-green-500/10',
  remove: 'bg-red-500/10',
  context: '',
}

/** Renders one diff line. The text goes through `StreamingMarkdown`
 * so bold/italic/headings/wikilinks/code render the same way the
 * editor draws them — `prose-sm` + the `&_*:my-0` margin reset keeps
 * the block compact enough to sit inside a card row. Context lines
 * get muted text on top of the standard prose so they recede.
 *
 * `truncate` still lives downstream as a safety net for absurdly
 * long pre-context lines; the cap is generous because most rows are
 * already short. */
function Line({ kind, text }: { kind: LineKind; text: string }) {
  const display = useMemo(() => truncate(text, 600), [text])
  return (
    <div
      className={cn(
        'flex items-stretch gap-2 overflow-hidden rounded-sm',
        KIND_BG[kind],
      )}
    >
      <div className={cn('w-[3px] shrink-0', KIND_BAR[kind])} />
      <div
        className={cn(
          'flex-1 min-w-0 px-1 py-0.5',
          // `[&_*]:my-0` collapses prose margins so a single-line
          // paragraph doesn't push the row to ~32px tall. Bigger
          // structural elements (heading / list) still get their own
          // padding from the typography plugin.
          'prose prose-sm dark:prose-invert max-w-none',
          '[&_p]:my-0 [&_ul]:my-0 [&_ol]:my-0 [&_li]:my-0',
          '[&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_h4]:my-0',
          '[&_blockquote]:my-0 [&_pre]:my-0',
          kind === 'context' && 'opacity-70',
        )}
      >
        <StreamingMarkdown content={display} isStreaming={false} />
      </div>
    </div>
  )
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/** Strip the vault prefix off an absolute file_path the model passed
 * in, so the card shows `daily/2026-05-24.md` instead of the full
 * `/Users/…/Vault/daily/2026-05-24.md`. Falls back to the original
 * path when no vault is selected or the path isn't a child. */
function toVaultRelative(filePath: string): string {
  if (!filePath) return ''
  const vault = getActiveVaultPath()
  if (!vault) return filePath
  // Normalise trailing slash on the vault root so prefix-strip lines
  // up against `${vault}/daily/...` cleanly.
  const root = vault.endsWith('/') ? vault : vault + '/'
  if (filePath.startsWith(root)) return filePath.slice(root.length)
  // Some hosts give the path in a slightly different shape (e.g.
  // resolved through symlinks). If the basename matches a known
  // top-level vault folder, take everything from that segment on.
  for (const dir of ['daily/', 'wiki/', 'writing/', '_system/']) {
    const idx = filePath.indexOf('/' + dir)
    if (idx !== -1) return filePath.slice(idx + 1)
  }
  return filePath
}

/** Lines whose only content is HTML/markdown spacing — we treat them
 * as noise when picking context lines so users see "the sentence
 * above" instead of "\<br /\>". */
const NOISE_LINE_PATTERNS = [
  /^<br\s*\/?>$/i,
  /^&nbsp;$/i,
  /^---+$/, // hr
  /^\*\*\*+$/, // hr alt
]

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  return NOISE_LINE_PATTERNS.some((re) => re.test(trimmed))
}

/** Build the diff for one Edit call. When the full doc body is
 * available, pull the surrounding lines from the file itself so the
 * card shows where in the doc the swap lands — what's "above" and
 * "below" the changed region, even if the model's `old_string` was
 * just a one-line anchor. Falls back to a substring-only diff when
 * the body hasn't loaded yet or the file doesn't exist (Write tool
 * creating a brand new page). */
function buildContextualDiff(
  fileText: string | null,
  oldText: string,
  newText: string,
  contextLines = 2,
): Array<{ kind: LineKind; text: string }> {
  if (fileText === null) return buildLineDiff(oldText, newText, contextLines)
  const idx = fileText.indexOf(oldText)
  if (idx === -1) return buildLineDiff(oldText, newText, contextLines)

  const fileLines = fileText.split('\n')

  // Find where the new content actually diverges from the old. The
  // line-based approach (start/end from `oldText.split('\n')`) gets
  // the position wrong whenever `old_string` matches mid-line: the
  // line containing the match is treated as part of the edit region
  // and disappears from pre-context, so the user sees context from
  // one paragraph earlier than the actual insertion point.
  //
  // Instead, walk character-by-character over old/new to find their
  // common prefix and common suffix. The "insertion anchor" — the
  // last unchanged character before the new content — sits at
  // `idx + commonPrefixLen - 1`. The line containing that anchor is
  // the natural last line of pre-context.
  let commonPrefixLen = 0
  const maxPrefix = Math.min(oldText.length, newText.length)
  while (
    commonPrefixLen < maxPrefix &&
    oldText.charCodeAt(commonPrefixLen) ===
      newText.charCodeAt(commonPrefixLen)
  ) {
    commonPrefixLen += 1
  }
  let commonSuffixLen = 0
  const maxSuffix = Math.min(
    oldText.length - commonPrefixLen,
    newText.length - commonPrefixLen,
  )
  while (
    commonSuffixLen < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - commonSuffixLen) ===
      newText.charCodeAt(newText.length - 1 - commonSuffixLen)
  ) {
    commonSuffixLen += 1
  }

  // Line of the last character of the common prefix in the file.
  // When the prefix is empty (pure replace at idx) anchorLine is the
  // line containing the start of the change instead.
  const anchorPrefixIdx =
    commonPrefixLen > 0 ? idx + commonPrefixLen : idx
  const anchorLine =
    fileText.slice(0, anchorPrefixIdx).split('\n').length - 1

  // Pre-context inclusion rule. If we kept the common-prefix tail in
  // the unchanged region, we include the anchor line as the closest
  // context (the user expects the line they're appending to to show
  // right above the +). On a pure replace (prefix empty) including
  // the anchor line would duplicate content with the `- removed`
  // row beneath it, so step one line up.
  const preContextStartLine =
    commonPrefixLen > 0 ? anchorLine : anchorLine - 1

  // Post-context anchor: the first character AFTER the edited region.
  // Mirrors the prefix logic using the common suffix so the same
  // off-by-one between "ends at \n" and "ends mid-line" can't hide
  // the line directly under the change.
  const oldEndIdx = idx + oldText.length
  const postAnchorIdx =
    commonSuffixLen > 0 ? oldEndIdx - commonSuffixLen : oldEndIdx
  const postAnchorLine =
    fileText.slice(0, postAnchorIdx).split('\n').length - 1
  const postContextStartLine =
    commonSuffixLen > 0 ? postAnchorLine : postAnchorLine + 1

  const preContext: string[] = []
  for (
    let i = preContextStartLine;
    i >= 0 && preContext.length < contextLines;
    i -= 1
  ) {
    if (isNoiseLine(fileLines[i])) continue
    preContext.unshift(fileLines[i])
  }

  const postContext: string[] = []
  for (
    let i = postContextStartLine;
    i < fileLines.length && postContext.length < contextLines;
    i += 1
  ) {
    if (isNoiseLine(fileLines[i])) continue
    postContext.push(fileLines[i])
  }

  const innerDiff = buildLineDiff(oldText, newText, 0)

  return [
    ...preContext.map((text) => ({ kind: 'context' as const, text })),
    ...innerDiff,
    ...postContext.map((text) => ({ kind: 'context' as const, text })),
  ]
}

/** Line-level diff with surrounding context. Splits both strings by
 * newline, peels off the common prefix/suffix, but keeps up to
 * `contextLines` meaningful lines on each side so the user can see
 * where the change lands ("after this sentence, before that one"),
 * not just the swap in isolation. Noise lines (blank, `<br />`, …)
 * are skipped when picking context. */
function buildLineDiff(
  oldText: string,
  newText: string,
  contextLines = 2,
): Array<{ kind: LineKind; text: string }> {
  if (oldText === newText) return []
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldChunk = oldLines.slice(prefix, oldLines.length - suffix)
  const newChunk = newLines.slice(prefix, newLines.length - suffix)

  // Pre-context: walk back from `prefix` and take meaningful lines
  // (skip blanks, <br />, hr). We collect at most `contextLines` lines
  // so the card stays compact. Read newLines[] (== oldLines[] in the
  // common region by definition) since they're identical here.
  const preContext: string[] = []
  for (let i = prefix - 1; i >= 0 && preContext.length < contextLines; i -= 1) {
    const line = newLines[i]
    if (isNoiseLine(line)) continue
    preContext.unshift(line)
  }

  // Post-context: walk forward from the line after the change.
  const postContextStart = newLines.length - suffix
  const postContext: string[] = []
  for (
    let i = postContextStart;
    i < newLines.length && postContext.length < contextLines;
    i += 1
  ) {
    const line = newLines[i]
    if (isNoiseLine(line)) continue
    postContext.push(line)
  }

  const rows: Array<{ kind: LineKind; text: string }> = []
  for (const line of preContext) rows.push({ kind: 'context', text: line })
  for (const line of oldChunk) {
    if (isNoiseLine(line)) continue
    rows.push({ kind: 'remove', text: line })
  }
  for (const line of newChunk) {
    if (isNoiseLine(line)) continue
    rows.push({ kind: 'add', text: line })
  }
  for (const line of postContext) rows.push({ kind: 'context', text: line })

  // Pure-whitespace swaps end up with zero rows even though there's
  // technically a change. Fall back to a single-row preview so the
  // card never renders blank.
  if (rows.length === 0) {
    if (newText) rows.push({ kind: 'add', text: newText.trim() || '(empty)' })
    else if (oldText) rows.push({ kind: 'remove', text: oldText.trim() || '(empty)' })
  }
  return rows
}
