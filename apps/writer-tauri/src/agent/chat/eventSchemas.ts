// Runtime validation for the sidecar → Rust → frontend event payloads.
//
// These payloads arrive as Tauri events forwarded by the Rust bridge, which
// passes `params` through untouched (see sidecar/PROTOCOL.md §4). Nothing
// between the sidecar and here type-checks them, so a bug or version skew on
// either side can deliver a malformed payload that would otherwise crash deep
// in the app (e.g. reading `.runId` off `undefined`).
//
// We validate the *routing envelope* — the handful of fields the host reads to
// deliver an event to the right run/thread — at the listener boundary. A bad
// payload becomes one logged warning and is dropped, instead of a crash.
//
// Deliberately minimal / loose:
//  - Only the routing key is required (`runId`, or `threadId` for the task
//    channel). Requiring more risks rejecting a valid payload whose optional
//    field happened to be absent, which for a `done`/`error` event would strand
//    the run forever — worse than the corruption we're guarding against.
//  - The SDK event blob inside `claude:event` is Anthropic's Agent-SDK shape:
//    we pass it through and it changes with the SDK, so it's checked only for
//    presence + object-ness, never deep-validated. Its rich typed shape is
//    documented by the ChatEvent interface in ./types.
//
// The compile-time types stay in ./types (the single source for shapes); these
// schemas are the single source for what counts as a *deliverable* envelope.
// Start strict enough to catch corruption, loose enough never to drop a real
// event; tighten later with the logged issues as evidence.

import { z } from 'zod'
import type { ChatEvent, DoneEvent, EditPendingEvent, ErrorEvent, TaskEvent } from './types'

const chatEventEnvelope = z.object({
  runId: z.string(),
  event: z.looseObject({ type: z.string().optional() }),
})

const doneEventEnvelope = z.object({
  runId: z.string(),
})

const errorEventEnvelope = z.object({
  runId: z.string(),
})

const taskEventEnvelope = z.object({
  threadId: z.string(),
})

// The one envelope here that requires more than its routing key, deliberately.
// The note above says requiring extra fields risks stranding a run — that
// reasoning is about `done`/`error`, where dropping the event is the worse
// outcome because nothing else will ever settle the run. Here it inverts:
// `pendingId` is not decoration, it is the id the sidecar parked its propose_*
// request under, so acting on a payload without one produces an ack addressed
// to nobody while a note gets materialized regardless. Dropping the event costs
// the tool's fail-open timeout, which is a bounded, logged wait — strictly
// better than a write nobody asked to confirm. `input` is required for the same
// reason: the mapper reads `file_path` out of it and has nothing to do without.
const editPendingEnvelope = z.object({
  runId: z.string(),
  pendingId: z.string(),
  toolName: z.string(),
  input: z.looseObject({}),
})

function makeParser<T>(schema: z.ZodType, channel: string): (raw: unknown) => T | null {
  return (raw: unknown): T | null => {
    const result = schema.safeParse(raw)
    if (!result.success) {
      console.warn(`[protocol] dropped malformed ${channel} payload`, result.error.issues, raw)
      return null
    }
    // Envelope validated; the rich, SDK-owned remainder is trusted as before
    // and typed by the corresponding interface in ./types.
    return raw as T
  }
}

/** Validate a `claude:event` payload envelope; returns it typed, or null (logged) if malformed. */
export const parseChatEvent = makeParser<ChatEvent>(chatEventEnvelope, 'claude:event')
/** Validate a `claude:done` payload envelope; returns it typed, or null (logged) if malformed. */
export const parseDoneEvent = makeParser<DoneEvent>(doneEventEnvelope, 'claude:done')
/** Validate a `claude:error` payload envelope; returns it typed, or null (logged) if malformed. */
export const parseErrorEvent = makeParser<ErrorEvent>(errorEventEnvelope, 'claude:error')
/** Validate a `claude:task` payload envelope; returns it typed, or null (logged) if malformed. */
export const parseTaskEvent = makeParser<TaskEvent>(taskEventEnvelope, 'claude:task')
/** Validate a `claude:edit-pending` payload; returns it typed, or null (logged) if malformed. */
export const parseEditPendingEvent = makeParser<EditPendingEvent>(
  editPendingEnvelope,
  'claude:edit-pending',
)

/** What the sidecar has to put on the wire for a proposal to be actionable.
 *
 * Derived from the schema, never listed by hand. The sidecar's own check of this
 * contract is a `.mjs` harness that cannot import this file (no TS loader), so
 * it holds the list as source — and `editPendingContract.test.ts` compares that
 * source against THIS value. Deriving is what makes the comparison mean
 * something: a hand-kept copy here would just be a second thing to rot. */
export const EDIT_PENDING_REQUIRED_FIELDS: readonly string[] = Object.freeze(
  Object.keys(editPendingEnvelope.shape).sort(),
)
