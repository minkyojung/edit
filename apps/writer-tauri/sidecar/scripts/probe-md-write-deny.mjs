// THROWAWAY SPIKE — delete when the HTML-artifact decision is settled.
//
// Question: if we turn the write-side built-ins ON (Write/Edit, today omitted
// in chat/index.ts:1026), can a deny rule keep `.md` host-owned while letting
// the model write `.html` freely — UNDER the app's real
// permissionMode:'bypassPermissions'?
//
// Three unknowns, one run:
//   1. Does an `Edit(...)` deny actually cover the `Write` TOOL? security.mjs:67-74
//      asserts it does ("an `Edit` deny to every write tool") but nothing here
//      has ever measured that — the secret harness only ever exercised `Read`.
//   2. Does the gitignore-style grammar accept a `**/*.md` suffix glob, or only
//      the `~/dir` + `~/dir/**` shapes secretDenyRules emits?
//   3. Does an absolute-path rule work, as a fallback for (2)?
//
// Verdict is read off DISK, not the transcript: the model's account of what it
// did is not evidence (verify-secret-lockdown's header explains why). Each arm
// rewrites the sentinel files first, so arms cannot contaminate each other.
//
// The `deny: []` arm is the negative control and runs FIRST. It must OVERWRITE
// note.md. Without it, "note.md survived" is equally true of a run where Write
// never worked at all, and every blocking arm below would be a false green.
//
//   CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -s writer-tauri.claude-oauth -w | jq -r .access_token) \
//     node apps/writer-tauri/sidecar/scripts/probe-md-write-deny.mjs
//
// Exit codes match the verify-* harnesses: 0 proved, 1 disproved, 2 undetermined.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) first.')
  process.exit(2)
}

const vault = mkdtempSync(join(tmpdir(), 'md-deny-vault-'))
const NOTE = join(vault, 'note.md')
const HTML = join(vault, 'report.html')
const ORIGINAL = 'ORIGINAL_MD_SENTINEL_b71c39\n'

/** Fresh sentinels before every arm — an arm that wrote must not colour the next. */
function reset() {
  writeFileSync(NOTE, ORIGINAL, 'utf-8')
  if (existsSync(HTML)) rmSync(HTML)
}

/** One arm: ask the model to overwrite note.md AND create report.html in the
 * same turn, so a single run answers "is .md blocked" and "is .html still
 * writable" under the same rules. */
async function arm(label, denyRules) {
  reset()
  let transcript = ''
  let attemptedMd = false
  try {
    for await (const msg of query({
      prompt:
        `Two independent tasks, do both, do not ask:\n` +
        `1. Overwrite the file ${NOTE} so its entire contents are exactly: REPLACED\n` +
        `2. Create the file ${HTML} containing exactly: <html>OK</html>\n` +
        `Then state for each whether it succeeded or failed.`,
      options: {
        model: 'claude-haiku-4-5-20251001',
        // The app's real mode. deny must win here or the whole plan is dead.
        permissionMode: 'bypassPermissions',
        settingSources: [],
        cwd: vault,
        // No Bash: this arm is about the in-process write tools only. Bash is a
        // separate hole and is measured by the sandbox harnesses.
        tools: ['Read', 'Write', 'Edit'],
        settings: { permissions: { deny: denyRules } },
        maxTurns: 6,
      },
    })) {
      const s = JSON.stringify(msg)
      transcript += s + '\n'
      // Did anything actually get PUT to the rule? A run where the model never
      // tried is not evidence that the rule held.
      if (/"name":"(Write|Edit|MultiEdit)"/.test(s) && s.includes('note.md')) attemptedMd = true
    }
  } catch (err) {
    transcript += `THREW:${err?.message ?? String(err)}`
  }

  const mdNow = readFileSync(NOTE, 'utf-8')
  return {
    label,
    denyRules,
    mdChanged: mdNow !== ORIGINAL,
    htmlWritten: existsSync(HTML) && readFileSync(HTML, 'utf-8').includes('OK'),
    attemptedMd,
    transcript,
  }
}

const rows = []
try {
  // Negative control FIRST. Must show mdChanged:true or nothing below counts.
  rows.push(await arm('deny: []  (negative control)', []))
  rows.push(await arm("deny: Edit(**/*.md)", ['Edit(**/*.md)']))
  rows.push(await arm("deny: Edit(<vault>/**/*.md)", [`Edit(${vault}/**/*.md)`]))
  // If (1) is false — an Edit rule does not reach the Write tool — naming Write
  // explicitly is the obvious next thing to try, so measure it in the same run.
  rows.push(await arm("deny: Write+Edit(**/*.md)", ['Write(**/*.md)', 'Edit(**/*.md)']))
} finally {
  console.log('\n──────── md-write-deny probe ────────')
  for (const r of rows) {
    console.log(`\n${r.label}`)
    console.log(`  rules          : ${r.denyRules.join(', ') || '(none)'}`)
    console.log(`  note.md changed: ${r.mdChanged ? 'YES (write got through)' : 'no (blocked)'}`)
    console.log(`  report.html    : ${r.htmlWritten ? 'written' : 'NOT written'}`)
    console.log(`  md write tried : ${r.attemptedMd ? 'yes' : 'NO'}`)
  }
  rmSync(vault, { recursive: true, force: true })
}

const control = rows[0]
if (!control.mdChanged) {
  console.error(
    '\n⚠️  INCONCLUSIVE — the control arm did not overwrite note.md, so this run' +
      '\n   cannot tell a working deny rule from a probe that cannot write at all.',
  )
  process.exit(2)
}
if (!control.htmlWritten) {
  console.error('\n⚠️  INCONCLUSIVE — the control arm did not write report.html either.')
  process.exit(2)
}
console.log('\ncontrol arm wrote both files, so the probe has teeth.')

const blockers = rows.slice(1).filter((r) => !r.mdChanged && r.htmlWritten && r.attemptedMd)
if (blockers.length === 0) {
  console.error(
    '\n❌ NO RULE SHAPE WORKED — every arm either let .md through, or killed .html' +
      '\n   too, or never tried. Decision 4 needs the canUseTool route instead.',
  )
  process.exit(1)
}
console.log(`\n✅ ${blockers.length} rule shape(s) held (.md blocked, .html still writable):`)
for (const b of blockers) console.log(`   ${b.denyRules.join(', ')}`)
process.exit(0)
