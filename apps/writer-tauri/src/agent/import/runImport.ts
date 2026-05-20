// File → bootstrapIngest pipeline. The Stage 2 caller (BootstrapDialog
// "Analyze") and the dev-console handle both enter through `runImport`.
// Each file is read, frontmatter-stripped, byte-chunked, and forwarded
// chunk-by-chunk to bootstrapIngest.
//
// Concurrency policy:
//
//   - Files in parallel (Promise.all over the picked paths). Mostly
//     I/O wait, so wide fan-out doesn't pressure the LLM.
//   - Chunks within a single file are SEQUENTIAL. A 200KB file becomes
//     4-5 LLM calls; firing them in parallel would burst against the
//     Anthropic rate limit with no real wall-clock win (each call is
//     already 5-10s).
//
// Failure policy: per-file try/catch. One unreadable file shouldn't
// kill the import — it just bumps the failed counter and the rest
// proceed. Errors are surfaced via console.error so the caller can
// stream them into the UI without a separate channel.

import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { bootstrapIngest } from '@/agent/bootstrapIngest'
import {
  stripFrontmatter,
  chunkText,
  inferSourceLabel,
} from '@/agent/import/parseImport'

export interface ImportProgress {
  /** Total files the user picked. Set once after the dialog returns;
   * 0 means the user cancelled. */
  filesTotal: number
  /** Files where every chunk has been processed (success or error). */
  filesDone: number
  /** Files that threw at any chunk. Surfaced for "X failed" UI. */
  filesFailed: number
  /** Running sum of proposals queued across all chunks so far. */
  proposalsCount: number
}

export interface ImportResult {
  filesProcessed: number
  filesFailed: number
  totalProposals: number
}

export interface RunImportOptions {
  /** Streaming progress callback. Fires after each file completes
   * (success or failure). UI uses this to update "Reading 3 / 5
   * files… 14 proposals so far". */
  onProgress?: (p: ImportProgress) => void
}

const FILE_EXTENSIONS = ['md', 'txt', 'json']

/** Launch the OS file picker, then drive every selected file through
 * bootstrapIngest. Returns the aggregate counts.
 *
 * Cancellation: if the user cancels the picker, returns immediately
 * with `{ filesProcessed: 0, filesFailed: 0, totalProposals: 0 }`.
 * No progress callback fires (filesTotal is 0). */
export async function runImport(
  opts: RunImportOptions = {},
): Promise<ImportResult> {
  const picked = await openDialog({
    title: 'Import notes',
    multiple: true,
    directory: false,
    filters: [{ name: 'Notes', extensions: FILE_EXTENSIONS }],
  })

  // openDialog returns null on cancel; with multiple:true it returns
  // string[] (possibly empty if the dialog quirks). Normalise both
  // into "nothing to do".
  const paths =
    picked === null
      ? []
      : Array.isArray(picked)
        ? picked
        : [picked]

  if (paths.length === 0) {
    return { filesProcessed: 0, filesFailed: 0, totalProposals: 0 }
  }

  // Mutable counters share-state across the file workers. Because
  // each worker is async but the counter writes are synchronous
  // (single-threaded JS), no lock is needed — each increment lands
  // atomically before the next microtask.
  const progress: ImportProgress = {
    filesTotal: paths.length,
    filesDone: 0,
    filesFailed: 0,
    proposalsCount: 0,
  }
  opts.onProgress?.(progress)

  const fileWorker = async (path: string): Promise<void> => {
    try {
      const raw = await readTextFile(path)
      const body = stripFrontmatter(raw)
      if (body.trim().length === 0) {
        // Empty after stripping → nothing for the LLM to chew on.
        // Count as a "done" file with zero proposals; don't flag as
        // failed since this is the user's choice of input.
        return
      }
      const sourceLabel = inferSourceLabel(path)
      const chunks = chunkText(body)
      for (const chunk of chunks) {
        const result = await bootstrapIngest({
          text: chunk,
          sourceLabel,
          sourceSlug: sourceLabel,
        })
        progress.proposalsCount += result.proposals.length
        // Mid-file progress: emit on each chunk so a single long
        // file still shows movement in the UI.
        opts.onProgress?.({ ...progress })
      }
    } catch (err) {
      console.error('[import] file failed', { path, err })
      progress.filesFailed += 1
    } finally {
      progress.filesDone += 1
      opts.onProgress?.({ ...progress })
    }
  }

  await Promise.all(paths.map(fileWorker))

  return {
    filesProcessed: progress.filesDone,
    filesFailed: progress.filesFailed,
    totalProposals: progress.proposalsCount,
  }
}

// Dev-only console handle. The BootstrapDialog Stage 2 wire (D.2.3)
// will be the real caller; this exists so we can exercise the full
// file → bootstrapIngest → enqueue path without driving the modal.
//   In DevTools:  await window.__runImport({ onProgress: console.log })
if (import.meta.env.DEV) {
  ;(window as unknown as { __runImport: typeof runImport }).__runImport = runImport
}
