#!/usr/bin/env node
// Guard: no magic font sizes.
//
// We migrated the app's type to the semantic scale (text-body, text-callout,
// text-footnote, text-caption, text-title-3/2/1 — backed by the --font-size-*
// ladder). Hardcoded `text-[Npx]` is the anti-pattern that drift comes from
// (someone eyeballs a size and types text-[15px]), so block new ones.
//
// Allowed exceptions:
//   - text-[15px]      : the deliberate chat reading-content size, still
//                        pending a `text-chat` token. Remove from this list
//                        once that token lands.
//   - GalleryPage.tsx  : the design-system gallery intentionally renders the
//                        raw scale as documentation.
//
// Run via `pnpm lint` (chained) or directly: `node scripts/check-font-sizes.mjs`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const ALLOWED_VALUES = new Set(['15px']) // chat content — pending text-chat token
const ALLOWED_FILES = ['GalleryPage.tsx']

const RE = /text-\[(\d+)px\]/g

/** @param {string} dir */
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(tsx?|jsx?)$/.test(name)) yield full
  }
}

const violations = []
for (const file of walk(SRC)) {
  if (ALLOWED_FILES.some((f) => file.endsWith(f))) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RE)) {
      if (ALLOWED_VALUES.has(`${m[1]}px`)) continue
      violations.push({ file: relative(ROOT, file), line: i + 1, cls: m[0] })
    }
  })
}

if (violations.length) {
  console.error('\n✗ Magic font sizes found — use a semantic utility instead:')
  console.error('  text-caption(11) text-footnote(12) text-callout(13) text-body(14) text-title-3(16) ...\n')
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.cls}`)
  console.error(`\n${violations.length} violation(s).\n`)
  process.exit(1)
}

console.log('✓ no magic font sizes')
