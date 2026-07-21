#!/usr/bin/env node
// Release guard: the version being shipped MUST have release notes, or the
// sidebar "What's new" card silently no-shows after the update — changelogFor()
// returns null for the running version, so WhatsNewSidebar marks it seen and
// renders nothing (see src/components/WhatsNew.tsx). This is exactly how 0.0.8
// shipped with no card.
//
// Run from both ship paths — the CI release workflow (.github/workflows/
// release.yml, the tag-driven path that actually publishes) and the local
// release preflight (build-release.sh). NOT the dev test suite: during normal
// development the current version is legitimately ahead of the changelog until
// a release is cut, so this must only gate an actual ship.

import { readFileSync } from 'node:fs'

const conf = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
)
const version = conf.version
const src = readFileSync(
  new URL('../src/lib/changelog.ts', import.meta.url),
  'utf8',
)

// Match the entry shape `version: '0.0.9'` (single/double/back quotes).
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const present = new RegExp(`version:\\s*['"\`]${escaped}['"\`]`).test(src)

if (!present) {
  console.error(
    `✗ changelog: no entry for ${version} — add one to src/lib/changelog.ts ` +
      `so the "What's new" card shows after this update.`,
  )
  process.exit(1)
}
console.log(`✓ changelog: release notes present for ${version}`)
