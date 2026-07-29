// The sidecar as a JSON-RPC *caller*, not only a server.
//
// Every question the sidecar needs to ask the host has so far been faked with a
// pair of notifications plus a hand-rolled correlation map — three times over
// (permission decisions, edit acks, note queries), each with its own id
// minting, its own cleanup, and its own timeout policy (none / 15s fail-open /
// 5s fail-closed). Those diverged by accident, not by design. This is the one
// mechanism they collapse into.
//
// Ids live in a separate namespace from the host's: each side correlates
// responses against the ids it minted, so the two counters may overlap without
// ambiguity. A frame arriving here with an id and no method is unambiguously an
// answer to something we asked.

import { request } from './jsonrpc.mjs'

export class Peer {
  #emit
  #nextId = 1
  #pending = new Map()

  constructor(emit) {
    this.#emit = emit
  }

  /** How many callers are still waiting. Exposed for the idle watchdog and for
   *  assertions — a non-zero count after teardown is a leak. */
  get pendingCount() {
    return this.#pending.size
  }

  /** Ask the host something. Resolves with the result, rejects with an Error
   *  carrying `code`/`data` on an error response or when the connection dies.
   *
   *  Deliberately no timeout: no JSON-RPC implementation in this space puts a
   *  deadline at the transport layer, because the transport cannot know what a
   *  given question means. Its one obligation is `settleAll` — nobody waits on
   *  a connection that is gone. Deadlines belong to the caller that knows
   *  whether waiting five seconds or five minutes is correct.
   *
   *  `opts.signal` is how a caller says it has stopped caring — a cancelled
   *  turn, say. It abandons the slot as well as rejecting, because racing the
   *  promise externally would leave the slot behind and it would live until
   *  `settleAll`. A permission gate waits on a human, so those slots are the
   *  ones most likely to be abandoned and least likely to be answered. */
  request(method, params, { signal } = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason)
      const onAbort = () => {
        this.#pending.delete(id)
        reject(signal.reason)
      }
      const settle = (fn) => (v) => {
        signal?.removeEventListener('abort', onAbort)
        fn(v)
      }
      // Register BEFORE emitting. The host can answer synchronously enough that
      // the reply is dispatched before `emit` returns, and a slot that isn't
      // there yet is a lost answer and a permanent hang.
      this.#pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.#emit(request(id, method, params))
      } catch (err) {
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
    })
  }

  /** Route a host response to its caller. Returns false if the id isn't ours,
   *  which is the caller's signal that this frame is something else. */
  settle(message) {
    const slot = this.#pending.get(message.id)
    if (!slot) return false
    this.#pending.delete(message.id)
    if (message.error) {
      const err = new Error(message.error.message ?? 'host request failed')
      err.code = message.error.code
      err.data = message.error.data
      slot.reject(err)
    } else {
      slot.resolve(message.result)
    }
    return true
  }

  /** Release every waiting caller. Call when the connection is gone — this is
   *  the guarantee that makes per-call timeouts a policy choice rather than the
   *  only defence against silence. */
  settleAll(error) {
    const slots = [...this.#pending.values()]
    this.#pending.clear()
    for (const slot of slots) slot.reject(error)
  }
}
