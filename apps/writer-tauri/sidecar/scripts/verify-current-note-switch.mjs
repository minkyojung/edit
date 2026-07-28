// Headless behavioural check: does the model follow the note the user MOVED to,
// mid-conversation?
//
// The bug this pins: a persistent thread resolves its systemPrompt exactly once,
// at the first turn (`#ensureThread` builds thread options; the reuse path in
// `#handleChatPersistent` drops `params.systemPrompt` entirely). The open note
// used to live in that system prompt, so a thread started on note A kept telling
// the model "the current note is A" for the rest of the conversation — the user
// navigated to B, asked a question, and got an answer about A.
//
// The fix moves the open note into a per-turn USER-message block
// (`currentNoteBlock` in src/agent/chat/systemPrompt.ts). That is a real bet on
// model behaviour and can't be unit-tested: the frozen system prompt still names
// A, and we're relying on a later user-turn statement to override it. This
// script drives a live sidecar exactly the way the app does and checks that it
// actually happens.
//
// Scenarios, all on ONE persistent thread (that's the whole point):
//   1. turn 1 on note A          → model says A
//   2. turn 2 after moving to B  → model says B      ← the regression
//   3. turn 3 with body omitted  → model still says B, and can quote B's body
//      from the earlier turn (pins the ledger's "path every turn, body only when
//      changed" split — a path-only turn must not lose the content)
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-current-note-switch.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN

if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set — cannot run the live model check.')
  process.exit(2)
}

// ── Scratch vault with two clearly-distinguishable notes ──────────────────
const vault = mkdtempSync(join(tmpdir(), 'note-switch-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })
const A_REL = 'wiki/lighthouse.md'
const B_REL = 'wiki/beekeeping.md'
const A_BODY = '# Lighthouse\n\nThe keeper logged the fog every morning at six.\n'
const B_BODY = '# Beekeeping\n\nThe hive swarmed in April and the queen was replaced.\n'
writeFileSync(join(vault, A_REL), A_BODY)
writeFileSync(join(vault, B_REL), B_BODY)

// The FROZEN system prompt — reproducing the OLD shape on purpose. It names
// note A and carries A's body, exactly as the pre-fix `--- CURRENT FILE ---` /
// `--- DOCUMENT ---` blocks did, and the thread is stuck with it for life.
//
// This is what makes the test adversarial rather than merely demonstrative: on
// turn 2 the system prompt is still insisting the current note is A while the
// user message says it's B. If the per-turn block did NOT win, turn 2 would
// answer "lighthouse" — which is precisely the bug users reported.
const systemPrompt = [
  'You are a writing assistant inside a note-taking app.',
  '--- WORKSPACE ---',
  `Vault root (absolute): ${vault}`,
  '--- CURRENT FILE ---',
  `The note the user is currently viewing is \`${A_REL}\`. When they say "this", ` +
    `"here", or "this note" without naming a file, they mean THIS note.`,
  `--- DOCUMENT ---\n${A_BODY}`,
].join('\n\n')

// Mirrors currentNoteBlock() in src/agent/chat/systemPrompt.ts. Kept as a copy
// rather than an import: the frontend is ESM-with-TS and this script drives the
// sidecar as a black box, so the copy is the contract under test. If you change
// the wording there, change it here and re-run.
function currentNoteBlock(path, body, bodyShownEarlier = false) {
  const lines = [
    '--- CURRENT NOTE ---',
    `As of this message, the user is looking at the note \`${path}\`. ` +
      `"this", "here", and "this note" refer to it when they don't name a file. ` +
      `They may still be asking about another note — this is where they are, not a limit on what they mean.`,
    `If an earlier message in this conversation named a different current note, that message is out of date. This one is current.`,
  ]
  if (body !== undefined) {
    lines.push(
      `Its content as of this message follows. Where an earlier message in this ` +
        `conversation shows a different version of this note, that version is stale ` +
        `and this one is accurate:\n\n${body}`,
    )
  } else if (bodyShownEarlier) {
    lines.push('Its content was included earlier in this conversation and has not changed since.')
  }
  return lines.join('\n')
}

// ── JSON-RPC plumbing (same shape as the other verify-* scripts) ──────────
const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'inherit'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifListeners = []

child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) {
      for (const l of notifListeners) l(msg)
    }
  }
})

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }))
  })
}

let failed = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => {
  failed = true
  console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`)
}

const threadId = randomUUID()

/** One turn on the shared persistent thread; returns the assistant's text. */
function turn(prompt) {
  const runId = randomUUID()
  let text = ''
  const collect = (msg) => {
    if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
      for (const b of msg.params.event.message?.content ?? []) {
        if (b.type === 'text' && typeof b.text === 'string') text += b.text
      }
    }
  }
  notifListeners.push(collect)
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve(text)
      else if (msg.method === 'chat/error') resolve(`__ERROR__ ${msg.params.code}`)
    })
    request('chat', {
      runId,
      threadId,
      persistentQuery: true,
      model: 'claude-sonnet-5',
      systemPrompt, // resent every turn, exactly as the app does — and ignored after turn 1
      prompt,
      vaultPath: vault,
      // Withhold the file tools so the answer has to come from the prompt, not
      // from a Read — a model that can Read the vault might find the right note
      // by luck and pass without the mechanism working.
      //
      // `[]` is the SDK's documented "disable all built-in tools", which is
      // exactly what this wants. It briefly had to say `['Glob']` instead,
      // because server.mjs was reading an empty array as "unspecified" and
      // answering with the full preset — granting the very access this comment
      // claims to deny. That inversion is fixed; `[]` means what it says again.
      builtinTools: [],
      relayTools: [],
      allowDelegation: false,
      sandboxEnabled: false,
    }).catch((err) => resolve(`__ERROR__ ${err?.message ?? String(err)}`))
  })
}

// Mirrors selectionBlock() in src/agent/chat/systemPrompt.ts — same copy
// caveat as currentNoteBlock above.
function selectionBlock(text) {
  return (
    `--- SELECTION ---\n` +
    `As of this message, the user has this passage selected in the editor. ` +
    `"this", "here", and "this part" refer to it when they don't name a target, ` +
    `and a request to explain / rewrite / fix without one is about this passage ` +
    `rather than the whole note. If an earlier message in this conversation shows ` +
    `a different selection, that message is out of date and this one is current:` +
    `\n\n${text}`
  )
}

// Mirrors viewingFileBlock() in src/agent/chat/systemPrompt.ts — same copy
// caveat as the two above.
function viewingFileBlock(path) {
  return (
    `--- VIEWING FILE ---\n` +
    `As of this message, the user is looking at the file \`${path}\` — a non-markdown ` +
    `file (PDF, image, audio), not a note. "this", "this file", and "here" refer to it ` +
    `when they don't name something else. If an earlier message in this conversation ` +
    `named a different file or note as the current one, that message is out of date and ` +
    `this one is current.\n` +
    `Its contents are not included here. Reading that exact path is what makes them ` +
    `available — Read ingests PDFs and images directly. It has no note body, so the ` +
    `note-editing tools don't apply to it.`
  )
}

const mentionsA = (t) => /lighthouse/i.test(t)
const mentionsB = (t) => /beekeeping/i.test(t)

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  // ── Turn 1: on note A ──────────────────────────────────────────────────
  console.log('\n  … turn 1 (viewing note A)')
  const t1 = await turn(
    `${currentNoteBlock(A_REL, A_BODY)}\n\nWhich note am I looking at? Answer with just the path.`,
  )
  console.log(`    → ${t1.trim().replace(/\n/g, ' ')}`)
  mentionsA(t1) && !mentionsB(t1)
    ? ok('turn 1 → note A')
    : bad('turn 1 did not identify note A', t1.trim())

  // ── Turn 2: user navigated to note B. THE REGRESSION. ──────────────────
  console.log('\n  … turn 2 (user moved to note B — same thread)')
  const t2 = await turn(
    `${currentNoteBlock(B_REL, B_BODY)}\n\nWhich note am I looking at now? Answer with just the path.`,
  )
  console.log(`    → ${t2.trim().replace(/\n/g, ' ')}`)
  mentionsB(t2) && !mentionsA(t2)
    ? ok('turn 2 → note B (per-turn block overrides the frozen system prompt)')
    : bad('turn 2 still answered with the OLD note — the bug is NOT fixed', t2.trim())

  // ── Turn 3: path only, body omitted (unchanged since turn 2) ───────────
  console.log('\n  … turn 3 (still on B; body omitted because it has not changed)')
  const t3 = await turn(
    `${currentNoteBlock(B_REL, undefined, true)}\n\nWhat happened in April according to this note? One sentence.`,
  )
  console.log(`    → ${t3.trim().replace(/\n/g, ' ')}`)
  const recalledBody = /swarm|queen/i.test(t3)
  recalledBody
    ? ok('turn 3 → answered from the body sent earlier (path-only turn keeps content)')
    : bad('turn 3 lost the note body when it was omitted', t3.trim())

  // ── Turns 4-5: the selection moves mid-conversation ────────────────────
  // The same freeze applied to the selection, and bit harder: a selection
  // changes on every drag, so a frozen one is stale almost immediately.
  console.log('\n  … turn 4 (selects the first line of B)')
  const t4 = await turn(
    `${currentNoteBlock(B_REL, undefined, true)}\n${selectionBlock('The hive swarmed in April')}` +
      `\n\nQuote the selected passage back to me exactly, nothing else.`,
  )
  console.log(`    → ${t4.trim().replace(/\n/g, ' ')}`)
  const t4ok = /swarmed in April/i.test(t4) && !/queen/i.test(t4)
  t4ok ? ok('turn 4 → quoted the first selection') : bad('turn 4 quoted the wrong text', t4.trim())

  console.log('\n  … turn 5 (user drags a NEW selection — same thread)')
  const t5 = await turn(
    `${currentNoteBlock(B_REL, undefined, true)}\n${selectionBlock('the queen was replaced')}` +
      `\n\nQuote the selected passage back to me exactly, nothing else.`,
  )
  console.log(`    → ${t5.trim().replace(/\n/g, ' ')}`)
  const t5ok = /queen was replaced/i.test(t5) && !/swarmed/i.test(t5)
  t5ok
    ? ok('turn 5 → quoted the NEW selection, not the frozen one')
    : bad('turn 5 answered with the OLD selection — still frozen', t5.trim())

  // ── Turns 6-7: the FileViewer (PDF/image) route ────────────────────────
  // Same freeze, plus a sharper failure once the note went per-turn: a frozen
  // VIEWING FILE block and a live CURRENT NOTE block state different things
  // about where the user is, and nothing tells the model which to believe.
  console.log('\n  … turn 6 (opens a PDF)')
  const t6 = await turn(
    `${viewingFileBlock('papers/lighthouse-optics.pdf')}` +
      `\n\nWhich file am I looking at? Answer with just the path.`,
  )
  console.log(`    → ${t6.trim().replace(/\n/g, ' ')}`)
  const t6ok = /lighthouse-optics\.pdf/i.test(t6)
  t6ok ? ok('turn 6 → the PDF') : bad('turn 6 did not identify the PDF', t6.trim())

  // Back to a note. The PDF block from turn 6 is still in the history and can't
  // be retracted, so this is the contradiction case: the model has to prefer the
  // block from THIS message.
  console.log('\n  … turn 7 (back to a note — the PDF block is still in history)')
  const t7 = await turn(
    `${currentNoteBlock(B_REL, undefined, true)}` +
      `\n\nWhat am I looking at right now? Answer with just the path.`,
  )
  console.log(`    → ${t7.trim().replace(/\n/g, ' ')}`)
  const t7ok = /beekeeping\.md/i.test(t7) && !/\.pdf/i.test(t7)
  t7ok
    ? ok('turn 7 → the note, not the stale PDF (no contradiction)')
    : bad('turn 7 answered with the stale PDF', t7.trim())

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => {
    child.kill('SIGTERM')
    console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
    process.exit(failed ? 1 : 0)
  }, 300)
}
