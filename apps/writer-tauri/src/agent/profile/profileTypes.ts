// Shared types for the Profile bootstrap pipeline. Mirrors the
// sidecar's `submit_profile` MCP tool schema (server.mjs) — both
// sides must stay in sync. Kept in its own file to avoid pulling
// the rest of the extract pipeline into modules that only need the
// type (e.g. the Stage 3 review UI).

/** Structured profile shape. Every field maps 1:1 to the
 * submit_profile tool's zod schema on the sidecar, except
 * source_urls which the host attaches after merging — the LLM
 * doesn't author URLs, the caller does. */
export interface ProfileFields {
  name: string | null
  headline: string | null
  location: string | null
  roles: string[]
  interests: string[]
  voice_samples: string[]
  values: string[]
  dispositions: string[]
  about: string
  /** Set by the host after synthesis. The LLM tool call doesn't
   * populate this — we add it from the original URL list. */
  source_urls: string[]
}

/** Per-URL partial — same shape as ProfileFields but tagged with
 * which source produced it. Synthesis pass receives an array of
 * these and merges across sources. */
export interface PartialProfile extends ProfileFields {
  source_url: string
  source_title: string | null
}

/** Empty profile sentinel — returned when extraction fails entirely
 * so callers don't have to special-case null. UI renders "no data
 * extracted" when about is empty. */
export const EMPTY_PROFILE: ProfileFields = {
  name: null,
  headline: null,
  location: null,
  roles: [],
  interests: [],
  voice_samples: [],
  values: [],
  dispositions: [],
  about: '',
  source_urls: [],
}
