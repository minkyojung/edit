// YouTube transcript summarizer. One Haiku call turns a (timestamped)
// transcript into a short markdown summary — TL;DR + key points with
// timestamps — that gets prepended to the capture note's body.
//
// Deliberately simple: a single call, not map-reduce. A typical talk's
// transcript is a few thousand tokens, well within Haiku's context, so
// chunking would be premature. Very long videos are truncated at
// INPUT_CAP (logged); map-reduce can be added later if that bites.
//
// The model returns markdown directly (no structured-output tool), so
// this needs no sidecar/Rust changes — it reuses awaitChatRun the same
// way generateAiSummary reuses claude_title.

import { invoke } from '@tauri-apps/api/core'
import { awaitChatRun } from '@/agent/chatRun'
import { getActiveVaultPath } from '@/state/settingsStore'

const MODEL = 'claude-haiku-4-5'
// ~30k tokens of transcript — covers roughly a 2-hour talk before we
// truncate. Beyond this the tail is dropped (summary still useful).
const INPUT_CAP = 120_000
const TIMEOUT_MS = 90_000

const SYSTEM = `You are summarizing a YouTube video transcript for someone who hasn't watched it. The transcript is plain text where most lines begin with a [mm:ss] or [h:mm:ss] timestamp.

Write the summary as GitHub-flavored markdown, in the SAME LANGUAGE as the transcript, using EXACTLY these two sections and nothing else:

## TL;DR
2–3 sentences capturing the core message.

## Key points
4–8 bullets. Begin each bullet with the most relevant [mm:ss] timestamp copied from the transcript, then a space, then the point.

Be concise and faithful — do not invent anything not present in the transcript. Output only the two sections: no preamble, no closing remarks.`

/** Summarize a transcript into markdown (TL;DR + key points). Returns
 *  null on any failure (timeout, sidecar error, empty output) so the
 *  caller can simply leave the raw transcript in place. */
export async function summarizeTranscript(
  transcript: string,
): Promise<string | null> {
  const input =
    transcript.length > INPUT_CAP ? transcript.slice(0, INPUT_CAP) : transcript
  if (!input.trim()) return null
  if (transcript.length > INPUT_CAP) {
    console.warn(
      `[youtube] transcript truncated for summary: ${transcript.length} → ${INPUT_CAP} chars`,
    )
  }

  const runId = crypto.randomUUID()
  // No relay tool — we want plain markdown text, so the result event
  // never fires and we read `outcome.text`.
  const finished = awaitChatRun<unknown>(runId, 'youtube:summary')

  try {
    await invoke('claude_chat_start', {
      args: {
        runId,
        model: MODEL,
        systemPrompt: SYSTEM,
        prompt: input,
        // Match the proven ingest/chat call shape: forward the vault path
        // (the sidecar wants it to set the run's working dir even though
        // this run uses no filesystem tools).
        vaultPath: getActiveVaultPath() ?? undefined,
        effort: 'low',
        sessionId: crypto.randomUUID(),
      },
    })
  } catch (err) {
    console.warn('[youtube] summarize invoke failed', err)
    return null
  }

  // awaitChatRun has no timeout of its own; cap the wait so a hung run
  // doesn't strand the background task. (The run still settles on the
  // sidecar's idle timeout and cleans up its own listeners.)
  const outcome = await Promise.race([
    finished.catch((err) => {
      console.warn('[youtube] summarize run failed', err)
      return null
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
  ])

  const text = outcome?.text?.trim()
  return text ? text : null
}

/** Compose the note body: the summary on top, the full transcript below
 *  a `## Transcript` heading. Pure — the summary call is separate. */
export function withSummary(summaryMarkdown: string, transcript: string): string {
  return `${summaryMarkdown.trim()}\n\n## Transcript\n\n${transcript.trim()}\n`
}
