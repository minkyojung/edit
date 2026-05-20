// Schema for the wiki:profile page, expressed in natural language so
// the LLM can read it directly as part of each section prompt.
//
// Why a const here and not a system:* page like system:conventions:
// the profile schema is tightly coupled to the pipeline's three
// section calls (Voice, Themes, About) — letting the user edit the
// schema mid-pipeline would risk the three calls disagreeing about
// what sections exist. If we later want user-customizable profile
// shape, we promote this to a wiki page; for now, a string keeps the
// pipeline self-contained.

/** Shared system-prompt prefix for every section call. Tells the LLM
 * what the wiki:profile page is for and how to ground its output. */
export const PROFILE_SYSTEM_PREAMBLE = `You are filling in a profile page that documents who the user is, based on their own writing. The page lives in the user's personal wiki and they will read and edit it directly.

Ground every claim in the provided posts. Never invent biographical facts (employer, location, education) that aren't visible in the posts. When a claim needs a source, prefer a short verbatim quote over paraphrase.

Keep prose plain. No marketing tone, no hedging filler.`

/** Per-section instructions. Each is appended to the preamble for
 * that section's LLM call. Order in the page = order in this object. */
export const PROFILE_SECTIONS = {
  voice: {
    heading: '## Voice',
    instruction: `Describe how the user writes. 2-4 bullets. Cover:
- sentence length and rhythm (short/long, declarative/interrogative)
- recurring phrasing, sentence endings, vocabulary tics
- tone (warm, terse, ironic, etc.)

Include 1-2 short quotes (one sentence each, verbatim from the posts) as evidence.`,
  },
  themes: {
    heading: '## Themes',
    instruction: `What does the user write about? 3-6 themes as bullets. Each bullet is a short noun phrase (2-6 words) followed by a one-sentence elaboration grounded in the posts. Order by how often the theme appears.`,
  },
  about: {
    heading: '## About',
    instruction: `A 2-3 sentence introduction to the user. Synthesize across all posts. Write in third person. Do not list facts; weave them into prose. Do not invent biography — if something isn't in the posts, don't include it.`,
  },
} as const

export type ProfileSectionKey = keyof typeof PROFILE_SECTIONS
