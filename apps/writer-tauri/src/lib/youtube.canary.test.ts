// @vitest-environment node
//
// Canary: confirms YouTube's ANDROID InnerTube caption path — the one our
// transcript capture depends on — is still alive. It exercises the REAL
// `fetchYoutubeCapture` against a known-stable public video, with the
// global `fetch` standing in for the in-app Tauri transport shim.
//
// This is an unofficial, undocumented path that YouTube breaks from time
// to time (client-version bumps, POT clampdowns). When it breaks, this
// canary fails — so we learn before users do and can ship a
// `youtube-transcript` bump. See the memory note for the WEB-vs-ANDROID
// history.
//
// Network-gated: skipped in the normal suite (no network in CI by
// default). Run it deliberately:  pnpm test:canary
//   (sets CANARY=1, which flips the skip below)

import { describe, expect, it } from 'vitest'
import { fetchYoutubeCapture, type FetchLike } from './youtube'

// FetchLike over the global fetch — the same contract the Tauri shim
// satisfies, so this tests the real orchestration minus the IPC hop.
const globalFetchAdapter: FetchLike = async (url, init) => {
  const r = await fetch(url, init as RequestInit)
  return {
    ok: r.ok,
    status: r.status,
    json: () => r.json(),
    text: () => r.text(),
  }
}

// "Me at the zoo" would be shortest, but Rick Astley has a stable manual
// English track and is the canonical never-deleted video.
const STABLE_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

// `process` isn't in the project's type lib (no @types/node); read the
// gate off globalThis so this typechecks without pulling node types in.
const canaryEnabled = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.CANARY,
)
const canaryIt = canaryEnabled ? it : it.skip

describe('youtube transcript canary (network)', () => {
  canaryIt(
    'still retrieves a transcript + metadata for a stable video',
    async () => {
      const cap = await fetchYoutubeCapture(STABLE_VIDEO, globalFetchAdapter)

      // Transcript actually came back (the thing that breaks under POT).
      expect(cap.bodyMarkdown.length).toBeGreaterThan(200)
      expect(cap.bodyMarkdown).toMatch(/^\[\d?\d?:?\d\d:\d\d\] /) // timestamped
      // Metadata path (oembed) resolved a real title, not the id fallback.
      expect(cap.title).not.toMatch(/^YouTube /)
      expect(cap.title.length).toBeGreaterThan(0)
      // Duration approximated from the transcript looks plausible.
      expect(cap.durationSec).toBeGreaterThan(60)
    },
    30_000, // network: generous timeout
  )
})
