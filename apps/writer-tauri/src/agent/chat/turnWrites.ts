// What one turn has written to, and what each note held before it did.
//
// Most of this app never needs this: a proposal is staged and the file on disk
// is untouched until the user Keeps it, so "what did that answer change" can be
// asked at leisure. Auto-accept is the exception — it writes DURING the turn,
// and by the time anything notices something went missing, the old text is
// nowhere. It has to be caught on the way past.
//
// This is the catching. One of these lives for the length of a turn and is told
// what a note holds in the moment before that note is written over.
//
// Knows nothing about the editor, the store or the protocol: it is handed
// strings and hands strings back. That is what lets it be tested without any of
// them, and what keeps it usable from wherever the write actually happens.

/** The notes one turn wrote to, and what each held first. */
export interface TurnWrites {
  /** Remember what `slug` holds, unless this turn remembers it already.
   *
   * The first call for a note is the one that counts. A turn that writes the
   * same file three times — a draft, a correction, a tidying up — is to be
   * reviewed against what stood there before it started, not against its own
   * second draft.
   *
   * `read` is called only when the answer is wanted, because the calls after
   * the first are the common case and each one would otherwise be a body read
   * whose result is thrown away. It should answer `''` for a note that does not
   * exist yet: a turn may create one, and "there was nothing here" and "the file
   * was empty" want the same treatment afterwards — everything in it is new. */
  aboutToWrite(slug: string, read: () => string): void
  /** Each note this turn wrote to, and what it held before, in slug order.
   *
   * Slug order rather than write order: which file the model happens to reach
   * for first is a fact about the model, and a list that reshuffles between two
   * identical turns reads as though something else happened. */
  before(): [slug: string, was: string][]
  /** Whether the turn wrote to any note at all. */
  isEmpty(): boolean
}

export function createTurnWrites(): TurnWrites {
  const before = new Map<string, string>()

  return {
    aboutToWrite(slug, read) {
      if (before.has(slug)) return
      before.set(slug, read())
    },
    before() {
      return [...before.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    },
    isEmpty() {
      return before.size === 0
    },
  }
}
