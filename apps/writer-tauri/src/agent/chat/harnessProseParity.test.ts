// The sidecar harnesses hand-copy production prose, and a copy rots silently.
//
// They drive the sidecar as a black box: they are `.mjs`, production is `.ts`,
// and making them import it would mean a loader dependency and would break the
// property that makes them useful — that they exercise the real transport rather
// than the app's own modules. So the copies stay, and this test makes them fail
// loudly instead of drifting quietly.
//
// This is not hypothetical. `verify-profile-title.mjs` claimed to mirror
// `pipeline.ts::callSection` for months after that symbol — and its file —
// stopped existing anywhere in the repo, and it kept passing the whole time.
//
// The direction that matters is production changing under a frozen copy: someone
// edits the wording in systemPrompt.ts, the harness keeps asserting against the
// old text, and its green result no longer means what it says. So each check
// CALLS the production function and asserts its real output appears in the
// harness source. Nothing here is a hand-transcribed expectation — that would
// just be a third copy to rot.
//
// vitest runs in CI as of the test-suite gate, so this costs nothing per PR.

import { describe, expect, it } from 'vitest'
import { currentNoteBlock, selectionBlock, viewingFileBlock } from './systemPrompt'
import { PREFERENCE_NUDGE_LINES } from './buildEditOutcomeNote'
// `?raw` rather than node:fs — the app tsconfig has no @types/node, and pulling
// it in for one test would be a project-wide dependency change. `vite/client` is
// already in `types` and declares these modules.
import currentNoteSwitchSrc from '../../../sidecar/scripts/verify-current-note-switch.mjs?raw'
import rejectPreferenceSrc from '../../../sidecar/scripts/verify-reject-preference.mjs?raw'

/** Production joins its prose into one runtime string; the harness holds the
 * same words as source, wrapped across lines and glued with `+`. Flatten both to
 * the same shape — drop the concatenation punctuation, collapse whitespace — so
 * the comparison is about WORDING and not about how either side happens to be
 * line-wrapped. Reformatting stays free; changing a sentence does not. */
function normalize(s: string): string {
  return s.replace(/[`+]/g, ' ').replace(/\s+/g, ' ')
}

/** The comparable units of a rendered block.
 *
 * Split on newlines first: production builds these blocks as an array of lines
 * joined with `\n`, and in the harness those are separate array elements with a
 * comma and quotes between them — a fragment spanning that boundary can never
 * match. Then split on the interpolated values, since the harness fills its own.
 * What's left is contiguous prose on both sides. */
function fixedFragments(rendered: string, ...interpolated: string[]): string[] {
  let parts = rendered.split('\n')
  for (const v of interpolated) {
    parts = parts.flatMap((p) => p.split(v))
  }
  return parts.map((p) => normalize(p).trim()).filter((p) => p.length > 24)
}

describe('verify-current-note-switch.mjs mirrors systemPrompt.ts', () => {
  const harness = normalize(currentNoteSwitchSrc)

  it('carries currentNoteBlock’s wording, in both the body and body-shown-earlier shapes', () => {
    const withBody = currentNoteBlock('wiki/x.md', 'BODY_SENTINEL')
    const shownEarlier = currentNoteBlock('wiki/x.md', undefined, true)
    for (const frag of [
      ...fixedFragments(withBody, 'wiki/x.md', 'BODY_SENTINEL'),
      ...fixedFragments(shownEarlier, 'wiki/x.md'),
    ]) {
      expect(harness, `production wording not found in the harness copy:\n${frag}`).toContain(frag)
    }
  })

  it('carries selectionBlock’s and viewingFileBlock’s wording', () => {
    for (const frag of [
      ...fixedFragments(selectionBlock('SEL_SENTINEL'), 'SEL_SENTINEL'),
      ...fixedFragments(viewingFileBlock('some/file.pdf'), 'some/file.pdf'),
    ]) {
      expect(harness, `production wording not found in the harness copy:\n${frag}`).toContain(frag)
    }
  })
})

describe('verify-reject-preference.mjs mirrors buildEditOutcomeNote.ts', () => {
  it('carries every line of the preference nudge', () => {
    const harness = normalize(rejectPreferenceSrc)
    for (const line of PREFERENCE_NUDGE_LINES) {
      const want = normalize(line).trim()
      expect(harness, `nudge line not found in the harness copy:\n${want}`).toContain(want)
    }
  })
})
