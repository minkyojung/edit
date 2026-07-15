// Per-key serialization primitive.
//
// Runs async operations that share a key strictly in call order, so a
// read-modify-write with an await between the read and the write can't
// interleave with another on the SAME key and silently clobber it (the later
// writer reads the same old value and overwrites the earlier writer's result —
// a lost update). Operations on DIFFERENT keys still run in parallel.
//
// This is the same pattern threadFiles.ts uses for per-thread file writes;
// extracted here as a tested unit so any read-modify-write path (e.g. the
// wiki-page apply loop) can reuse one audited implementation.

const chains = new Map<string, Promise<unknown>>()

/** Run `fn` after any prior operation on the same `key` has settled. Enqueues
 * synchronously, so call order == execution order. A failed op doesn't block
 * the next one (the chain continues on both fulfil and reject). */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(key, next)
  // Drop the entry once it's the tail and settled, so the map doesn't grow
  // unbounded over a long session. Use then(settle, settle) rather than
  // finally() so a REJECTED op is handled on this bookkeeping branch (settle
  // absorbs it) and doesn't surface as an unhandled rejection — the caller still
  // sees the rejection through the returned `next`.
  const settle = () => {
    if (chains.get(key) === next) chains.delete(key)
  }
  void next.then(settle, settle)
  return next as Promise<T>
}
