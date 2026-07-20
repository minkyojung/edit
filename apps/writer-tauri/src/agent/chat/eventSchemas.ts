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
import type { ChatEvent, DoneEvent, ErrorEvent, TaskEvent } from './types'

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
