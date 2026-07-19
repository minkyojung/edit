// Headless behavioural check for compound-loop change #2: CLAUDE.md now tells
// the model to end a NON-TRIVIAL edit proposal with one line naming what it's
// least confident about, so the user knows what to check before approving.
// This is a prompt-only change — no code path to unit-test — so the only real
// verification is: does the model actually append that line for a judgement
// call, and OMIT it for a trivial dictated fix?
//
// Drives a live sidecar like the app does (real persona + CLAUDE.md, propose_*
// relay, scratch vault) and inspects the assistant TEXT reply.
//
//   CASE=disclose (default) — model must infer facts → EXPECT a least-sure line
//   CASE=trivial            — verbatim word swap → EXPECT no least-sure line
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-uncertainty-disclosure.mjs
//   CASE=trivial CLAUDE_CODE_OAUTH_TOKEN=... node scripts/verify-uncertainty-disclosure.mjs

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
const CASE = process.env.CASE === 'trivial' ? 'trivial' : 'disclose'

if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set — cannot run the live model check.')
  process.exit(2)
}

// ── Scratch vault: a note thin on detail, so adding a summary forces the model
//    to INFER (a judgement call) rather than copy. ──────────────────────────
const vault = mkdtempSync(join(tmpdir(), 'uncertainty-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })
const notePath = join(vault, 'wiki', 'meeting-notes.md')
writeFileSync(
  notePath,
  '# Q3 planning\n\n' +
    'We compared three roadmaps. Jane argued the pricing revamp should come ' +
    'before the mobile app because churn is highest on annual plans. Marco ' +
    'wanted mobile first for the App Store feature slot in September. Priya ' +
    'noted the pricing change needs legal review that could take 6 weeks. ' +
    'We agreed to lock scope by Friday and to prototype the pricing page in ' +
    'parallel so neither track blocks the other.\n',
)

const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')
const systemPrompt = [
  persona,
  '--- CLAUDE.md ---',
  claudeMd,
  '--- WORKSPACE ---',
  `Vault root (absolute): ${vault}`,
  `Current file (absolute): ${notePath}`,
].join('\n\n')

// disclose: asking for a one-line "outcome/decision" forces inference from an
// unresolved note → non-trivial. trivial: a verbatim word swap the user dictates.
const prompt =
  CASE === 'trivial'
    ? "In meeting-notes.md, change the word 'revamp' to 'overhaul'. Nothing else."
    : 'Add a one-line **Summary:** at the top of meeting-notes.md capturing the key takeaway.'

// ── JSON-RPC plumbing ─────────────────────────────────────────────────────
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

let assistantText = ''
let proposed = false
notifListeners.push((msg) => {
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
    for (const b of msg.params.event.message?.content ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') assistantText += b.text
    }
  }
  if (msg.method === 'chat/edit-pending' || msg.method === 'chat/write-pending') proposed = true
})

function runChat(runId) {
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      runId,
      model: 'claude-sonnet-5',
      systemPrompt,
      prompt,
      vaultPath: vault,
      relayTools: ['propose_edit', 'propose_write', 'propose_skill', 'move_note'],
      builtinTools: ['Read', 'Glob', 'Grep'],
      allowDelegation: false,
      sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

// The disclosure line: literal English label from CLAUDE.md's example, or a
// natural-language "least/less confident / not sure" phrasing (any language).
const DISCLOSURE_RE = /least sure|least confident|less confident|not (?:fully )?(?:sure|certain)|자신\s*(?:이)?\s*없|덜\s*확신|확신\S*\s*(?:이)?\s*없/i

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  console.log(`  … running chat turn (case=${CASE})`)
  const r = await runChat('uncertainty-1')
  if (r.kind !== 'ok') bad('chat run did not complete', JSON.stringify(r))

  console.log('\n  --- assistant reply ---\n  ' + assistantText.trim().replace(/\n/g, '\n  ') + '\n')
  const hasLine = DISCLOSURE_RE.test(assistantText)
  proposed ? ok('model proposed an edit') : bad('model proposed no edit (test setup issue)')

  if (CASE === 'disclose') {
    hasLine
      ? ok('non-trivial edit → reply discloses least-confident point')
      : bad('non-trivial edit → NO least-confident line in reply')
  } else {
    hasLine
      ? bad('trivial edit wrongly padded with a least-confident line')
      : ok('trivial edit → no hedging line (correct)')
  }

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
