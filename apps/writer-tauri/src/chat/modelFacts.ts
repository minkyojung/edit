// A module-level snapshot of what the fetched catalog knows about each model,
// so the plain lookup helpers (labelForModel, effortsForModel,
// contextLimitForModel) can consult it without becoming React hooks.
//
// Why a registry rather than reading the store directly: two of those callers
// are NOT components — the context gauge computes a snapshot inside
// agent/chat, and the intake path reads its model outside React — so a hook
// isn't available to them. Importing the store from types.ts instead would
// create a cycle (types → store → modelCatalog → types). This module imports
// NOTHING, which keeps the graph acyclic: types/contextLimit/modelCatalog all
// depend on it, and only the store writes to it.
//
// Empty until the first successful fetch, and every reader falls back to its
// built-in table, so nothing here is load-bearing for correctness — it only
// makes the answers fresher.

/** The subset of a merged catalog row the lookups need. Structurally a subset
 * of MergedModel, declared locally so this module stays dependency-free. */
export interface ModelFacts {
  id: string
  displayName?: string
  maxInputTokens?: number
  /** Left as plain strings: narrowing to the app's effort union happens in the
   * reader, which owns that union. */
  efforts?: readonly string[]
}

/** Identity key for model ids. The catalog spells some models with a release
 * date (`claude-haiku-4-5-20251001`) while the app sends the bare form
 * (`claude-haiku-4-5`); both serve and both mean the same model, so every
 * lookup and dedupe keys on this. */
export function familyKey(id: string): string {
  return id.replace(/-\d{8}$/, '')
}

let facts = new Map<string, ModelFacts>()

/** Publish the merged catalog. Called by the models store on a successful
 * fetch (and at startup from its cache). Replaces wholesale — the merge that
 * produced this list is already additive, so there's nothing to accumulate. */
export function setModelFacts(entries: readonly ModelFacts[]): void {
  const next = new Map<string, ModelFacts>()
  for (const entry of entries) {
    if (entry?.id) next.set(familyKey(entry.id), entry)
  }
  facts = next
}

/** What the catalog knows about `id`, or undefined when it hasn't been fetched
 * or doesn't cover this model. Callers MUST fall back to their built-in table. */
export function modelFactsFor(id: string): ModelFacts | undefined {
  return facts.get(familyKey(id))
}

/** Test-only: drop the snapshot so a case can assert built-in fallback. */
export function _resetModelFacts(): void {
  facts = new Map()
}
