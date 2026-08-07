// Headless end-to-end check that `propose_edit` reports its OUTCOME to the model.
// Drives a live sidecar; this harness plays the HOST, so it controls the verdict
// each proposal gets and can watch what the model does next.
//
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   CLAUDE_CONFIG_DIR=$(mktemp -d) \        # avoid unrelated user hooks
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   node scripts/verify-edit-roundtrip.mjs
//
// WHY: edits are STAGED — the file on disk deliberately stays unchanged until the
// user accepts. So a model that cannot see a verdict has no way to tell "staged,
// waiting for the user" from "failed": re-reading shows the old text either way.
// Observed in the real app (2026-07-27): one requested edit produced TWO review
// cards, and the model closed with "it's already changed" — it had proposed,
// failed to confirm, proposed again, then rationalised.
//
// The verdict used to be delivered by a PostToolUse hook REWRITING an optimistic
// "queued" string the handler had already returned. verify-stale-retry.mjs
// measured that path at ~2/3 delivery (the rewrite races the model's consumption
// of the tool result) — which is why propose_write was converted to a round-trip
// first. This harness covers the same conversion for propose_edit/multi_edit:
// the handler now awaits the host verdict and returns it DIRECTLY, so there is
// no optimistic claim left to correct and nothing to race.
//
// Three verdicts, three runs — each asserts what the MODEL received, not just
// what the sidecar emitted:
//   A. ok           → "queued for user review", and exactly ONE proposal
//   B. ok:false     → "NOT queued" (previously lost ~1/3 of the time)
//   C. applied:true → "Applied immediately" (auto-accept; this text moved out of
//                     the deleted hook, so it is the regression this guards)

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const APP_SRC = join(__dirname, '..', '..', 'src', 'agent', 'defaults')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) { console.log('No CLAUDE_CODE_OAUTH_TOKEN set.'); process.exit(2) }

const ORIGINAL = '# Greeting\n\n안녕하세요\n'
const vault = mkdtempSync(join(tmpdir(), 'edit-rt-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })
const notePath = join(vault, 'wiki', 'Greeting.md')

const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')
const systemPrompt = [persona, '--- CLAUDE.md ---', claudeMd, '--- WORKSPACE ---', `Vault root (absolute): ${vault}`].join('\n\n')

const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'inherit'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifListeners = []
child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) { for (const l of notifListeners) l(msg) }
  }
})
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(encode({ jsonrpc: '2.0', id, method, params })) })
}
function notify(method, params) { child.stdin.write(encode({ jsonrpc: '2.0', method, params })) }
/** Answer a request the sidecar sent US — the verdict IS the tool's result. */
function respond(id, result) { child.stdin.write(encode({ jsonrpc: '2.0', id, result })) }

let failed = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => { failed = true; console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`) }

// Per-run capture. `verdict` decides how this harness (as HOST) acks.
let proposals = []
let toolResults = []
let assistantText = ''
let verdict = { ok: true }

notifListeners.push((msg) => {
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
    for (const b of msg.params.event.message?.content ?? []) if (b.type === 'text') assistantText += b.text
  }
  // What the model actually RECEIVED. Tool results arrive as 'user'-type events.
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'user') {
    for (const b of msg.params.event.message?.content ?? []) {
      const text = typeof b?.content === 'string' ? b.content
        : Array.isArray(b?.content) ? b.content.map((c) => c?.text ?? '').join(' ') : ''
      if (text) toolResults.push(text)
    }
  }
  // HOST role: record the proposal and return this run's verdict.
  if (msg.method === 'host/editPending') {
    const { pendingId, toolName, input } = msg.params
    proposals.push({ pendingId, toolName, input })
    console.log(`  … proposal #${proposals.length} (${toolName}) — acking ${JSON.stringify(verdict)}`)
    respond(msg.id, verdict)
  }
})

function runChat(runId, prompt) {
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      runId, threadId: runId, model: 'claude-sonnet-5', systemPrompt, prompt, vaultPath: vault,
      relayTools: ['propose_edit'],
      builtinTools: ['Read', 'Glob', 'Grep'], allowDelegation: false, sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

const PROMPT = 'In wiki/Greeting.md, change 안녕하세요 to 반갑습니다. Make exactly that one edit.'

async function scenario(label, v) {
  // Reset: same starting file every time, so each run is independent.
  writeFileSync(notePath, ORIGINAL)
  proposals = []; toolResults = []; assistantText = ''; verdict = v
  console.log(`\n  --- ${label} ---`)
  const r = await runChat(globalThis.crypto.randomUUID(), PROMPT)
  if (r.kind !== 'ok') bad(`${label}: chat run did not complete`, JSON.stringify(r))
  return toolResults.join('\n')
}

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  // A — the happy path. The headline assertion is the COUNT: with the verdict
  // delivered, one requested edit must produce exactly one proposal.
  {
    const seen = await scenario('A. verdict ok → queued, exactly one proposal', { ok: true })
    proposals.length === 1
      ? ok(`exactly ONE proposal for one requested edit (${proposals.length})`)
      : bad(`expected 1 proposal, got ${proposals.length} — the duplicate-card bug`);
    /queued for user review/i.test(seen)
      ? ok('model received "queued for user review"')
      : bad('model never received the queued confirmation')
    // The file must still be untouched — staging is the whole premise.
    readFileSync(notePath, 'utf8') === ORIGINAL
      ? ok('file on disk unchanged (staged, not applied)')
      : bad('file was modified — staging contract broken')
  }

  // B — refusal. This is the message that used to be lost ~1/3 of the time,
  // leaving the model believing a card existed when none did.
  {
    const seen = await scenario('B. verdict ok:false → refusal reaches the model', {
      ok: false, reason: 'the anchor text was not found in the current document',
    });
    /NOT queued/i.test(seen)
      ? ok('model received the "NOT queued" refusal')
      : bad('refusal NEVER reached the model — the round-trip did not deliver');
    /anchor text was not found/i.test(seen)
      ? ok('refusal carried the host\'s reason')
      : bad('reason was dropped from the refusal')
  }

  // C — auto-accept. This text lived in the PostToolUse hook that this change
  // deletes; if the port were missed it would vanish silently and the model
  // would tell users to "reject the card" for a change already on disk.
  {
    const seen = await scenario('C. verdict applied → auto-accept notice survives', { ok: true, applied: true });
    /Applied immediately/i.test(seen)
      ? ok('model received the auto-accept notice')
      : bad('auto-accept notice LOST — regression from removing the PostToolUse hook')
    !/queued for user review/i.test(seen)
      ? ok('auto-accept did NOT also claim a review card exists')
      : bad('model got BOTH "applied" and "queued" — contradictory')
    console.log('\n  --- assistant reply (C) ---\n  ' + assistantText.trim().replace(/\n/g, '\n  '))
    !/reject/i.test(assistantText)
      ? ok('reply does not tell the user to reject a nonexistent card')
      : bad('reply still mentions rejecting — the notice did not take')
  }

  // D — the host, not the sidecar, adjudicates anchors.
  //
  // The sidecar used to read the file off DISK and reject a non-matching
  // old_string itself, so a proposal like this never reached the host at all.
  // Two things were wrong with that: disk is the wrong document (staging makes
  // it lag the buffer on purpose), and `indexOf` is stricter than the applier's
  // tolerant matcher — measured, body '* 날짜: 미정' with old_string
  // '- 날짜: 미정' is indexOf -1 but locateLoose 'found', i.e. the sidecar was
  // refusing edits the host would simply have placed.
  //
  // Read is withheld so the model can't discover the mismatch and self-correct;
  // what is under test is the routing, not the model's judgement.
  {
    writeFileSync(notePath, ORIGINAL)
    proposals = []; toolResults = []; assistantText = ''
    verdict = { ok: false, reason: 'the anchor text was not found in the current document' }
    console.log('\n  --- D. an unmatched anchor still reaches the host ---')
    const r = await new Promise((resolve) => {
      const runId = globalThis.crypto.randomUUID()
      notifListeners.push((msg) => {
        if (msg.params?.runId && msg.params.runId !== runId) return
        if (msg.method === 'chat/done') resolve({ kind: 'ok' })
        else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
      })
      request('chat', {
        runId, threadId: runId, model: 'claude-sonnet-5', systemPrompt, vaultPath: vault,
        prompt:
          'Call propose_edit on wiki/Greeting.md with old_string exactly ' +
          '"존재하지않는문장" and new_string exactly "X". Do not read the file first — ' +
          'call the tool directly with those exact values.',
        relayTools: ['propose_edit'],
        // NOT `[]` — the sidecar reads an empty array as "unspecified" and hands
        // over the full claude_code preset, Read and Bash included. Naming one
        // harmless tool is how you actually withhold the rest.
        builtinTools: ['Glob'], allowDelegation: false, sandboxEnabled: false,
      }).catch((err) => resolve({ kind: 'error', code: err?.code }))
    })
    if (r.kind !== 'ok') bad('D: chat run did not complete', JSON.stringify(r))
    proposals.length >= 1
      ? ok('proposal reached the HOST (sidecar no longer adjudicates on disk)')
      : bad('proposal never reached the host — a disk-side check rejected it first')
  }

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => { child.kill('SIGTERM'); console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS'); process.exit(failed ? 1 : 0) }, 300)
}
