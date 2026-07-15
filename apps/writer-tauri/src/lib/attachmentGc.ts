// Garbage-collect orphaned chat attachment files.
//
// Attachments are written to `.octave/attachments/<id>/<name>` on attach and
// referenced by the vault path persisted on each user turn's file attachment.
// A file is LIVE while some persisted turn references it; anything else is an
// orphan (a send that was never cleaned, an abandoned draft, a deleted thread).
//
// The composer's draft store is memory-only, so at boot the only references are
// persisted turns — that makes a boot-time sweep safe: collect every id any
// turn points at, then delete the on-disk id dirs nobody points at. Runs
// best-effort in the background so it never blocks boot.

import { listThreadIds, readThreadTurns } from '@/lib/threadFiles'
import { listVaultDir, deleteVaultDir } from '@/lib/vault'
import { OCTAVE_ATTACHMENTS_DIR } from '@/lib/octave'

/** `.octave/attachments/<id>/<name>` → `<id>` (null if the path isn't one). */
function attachmentIdFromPath(path: string): string | null {
  const prefix = `${OCTAVE_ATTACHMENTS_DIR}/`
  if (!path.startsWith(prefix)) return null
  const id = path.slice(prefix.length).split('/')[0]
  return id || null
}

/** Delete `.octave/attachments/<id>/` folders no persisted turn references.
 * Returns the number of orphan folders removed. Best-effort: any read/delete
 * failure is swallowed so a boot sweep never surfaces an error. */
export async function sweepOrphanAttachments(): Promise<number> {
  // 1. Collect ids referenced by any persisted turn across all threads.
  const referenced = new Set<string>()
  let threadIds: string[]
  try {
    threadIds = await listThreadIds()
  } catch {
    return 0
  }
  for (const tid of threadIds) {
    let turns
    try {
      turns = await readThreadTurns(tid)
    } catch {
      continue
    }
    for (const t of turns) {
      for (const a of t.attachments ?? []) {
        if (a.type === 'file' && a.path) {
          const id = attachmentIdFromPath(a.path)
          if (id) referenced.add(id)
        }
      }
    }
  }

  // 2. Delete the on-disk id dirs nobody references. listVaultDir throws when
  //    the folder doesn't exist yet (no attachments ever written) — nothing to do.
  let dirs: string[]
  try {
    dirs = await listVaultDir(OCTAVE_ATTACHMENTS_DIR)
  } catch {
    return 0
  }
  let removed = 0
  for (const id of dirs) {
    if (referenced.has(id)) continue
    try {
      await deleteVaultDir(`${OCTAVE_ATTACHMENTS_DIR}/${id}`)
      removed++
    } catch {
      // leave it; next boot retries
    }
  }
  return removed
}
