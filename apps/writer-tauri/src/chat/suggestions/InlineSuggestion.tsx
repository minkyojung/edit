// Bridges a chat edit-tool part (propose_edit / write / multi_edit) to its
// live PendingChange and renders it as a unified ActivityRow — the same
// row shape as every other tool (icon + "Edit" + file chip), with the diff in
// the (default-open) body. The link is `part.pendingId`, stamped onto the part
// from the tool_result text (see streamParser). Two phases:
//   - Live: the store has the change → diff + status, jump-to-note affordance,
//     status synced across every surface (editor widget, Review panel).
//   - Historical: the change was pruned after a decision (or dropped / still
//     streaming) → no store entry. We fall back to the diff reconstructed from
//     `part.input`, which is permanent in the message, so scrolling back still
//     shows what the edit proposed.

import { useMemo } from 'react'
import { IconExternalLink, IconPencil } from '@tabler/icons-react'
import type { ToolPart } from '@/chat/types'
import { usePendingChangesStore, rejectPendingChange } from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'
import { computePendingDiffLines } from '@/lib/pendingDiff'
import { DiffBlock } from '@/components/DiffBlock'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { FileChip } from '@/chat/parts/FileChip'
import { humanizeToolCall } from '@/chat/humanizers'
import { navigateToNoteBySlug } from '@/editor/cmNav'
import { requestScrollToChange } from '@/state/activeCmEditor'
import { pathForDoc } from '@/lib/docPaths'
import { diffLinesFromToolInput } from './toolInputDiff'

function basename(path: string | null | undefined): string | null {
  if (!path) return null
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx >= 0 ? path.slice(idx + 1) : path
}

export function InlineSuggestion({ part }: { part: ToolPart }) {
  const change = usePendingChangesStore((s) =>
    part.pendingId ? s.byId[part.pendingId] : undefined,
  )
  // Chip label = the note's actual file name (daily/2026-06-20.md → "2026-06-20.md",
  // wiki/<Title>.md → "<Title>.md"). The on-disk names are already human-readable
  // via pathForDoc, so showing the file name is consistent with the dropped-edit
  // row below (which uses basename(file_path)) and never leaks a type like "daily".
  const docFileName = useDocsStore((s) => {
    if (!change) return null
    const doc = s.knownDocs.find((d) => d.slug === change.pageSlug)
    if (!doc) return null
    const path = pathForDoc(doc, (sl) => s.knownDocs.find((d) => d.slug === sl))
    return path ? basename(path) : null
  })
  // Same store action the Review tray + editor widget call, so a Keep here
  // stays in sync with every other surface (single source of truth).
  const accept = usePendingChangesStore((s) => s.accept)
  const fallbackDiff = useMemo(
    () => diffLinesFromToolInput(part.toolName, part.input),
    [part.toolName, part.input],
  )

  // `_system/*` writes (log.md, index.md, …) are host-managed bookkeeping:
  // toPendingChange drops them from the review queue and the host appends the
  // log itself. So don't render their (fallback) diff in the chat — they're
  // not content the user reviews. NOTE: this guard must sit AFTER every hook —
  // file_path arrives mid-stream, so an early return above the hooks would
  // change the hook count between renders.
  const filePath = (part.input as { file_path?: string } | null)?.file_path
  if (typeof filePath === 'string' && filePath.includes('_system/')) return null

  const diffLines = change ? computePendingDiffLines(change) : fallbackDiff
  const added = diffLines.filter((l) => l.kind === 'add').length
  const removed = diffLines.filter((l) => l.kind === 'remove').length
  const { label } = humanizeToolCall(part.toolName, part.input)
  const name = docFileName ?? basename(filePath) ?? 'document'
  const status = change?.status
  const isPending = status === 'pending'

  // While the input is still arriving there's no diff yet; show the header row
  // in a calm pending state rather than the old tiny "Preparing edit…" text.
  const preparing =
    diffLines.length === 0 &&
    (part.state === 'input-streaming' || part.state === 'input-available')
  // Historical change pruned and nothing reconstructable → render nothing.
  if (diffLines.length === 0 && !preparing) return null

  const jump = change
    ? () => {
        if (navigateToNoteBySlug(change.pageSlug)) {
          requestScrollToChange(change.pageSlug, change.id)
        }
      }
    : undefined

  return (
    <ActivityRow
      icon={<IconPencil size={14} />}
      label={label}
      accessory={
        <>
          <FileChip name={name} />
          {(added > 0 || removed > 0) && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
              {added > 0 && <span className="text-success">+{added}</span>}
              {removed > 0 && <span className="text-destructive">-{removed}</span>}
            </span>
          )}
          {status && status !== 'pending' && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {status === 'accepted' ? 'Kept' : 'Rejected'}
            </span>
          )}
        </>
      }
      trailing={
        jump ? (
          <button
            type="button"
            onClick={(e) => {
              // The row is itself a trigger; stop propagation so the jump
              // doesn't also toggle the diff open/closed.
              e.stopPropagation()
              jump()
            }}
            aria-label="Jump to this change in the note"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <IconExternalLink size={12} />
          </button>
        ) : undefined
      }
      detail={
        diffLines.length > 0 || isPending ? (
          <>
            {diffLines.length > 0 && <DiffBlock lines={diffLines} />}
            {isPending && change && (
              <div className="flex items-center justify-end gap-1 pt-1.5">
                <button
                  type="button"
                  className="pending-edit__action pending-edit__action--reject"
                  onClick={() => rejectPendingChange(change.id)}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="pending-edit__action pending-edit__action--keep"
                  onClick={() => accept(change.id)}
                >
                  Keep
                </button>
              </div>
            )}
          </>
        ) : undefined
      }
      defaultOpen
    />
  )
}
