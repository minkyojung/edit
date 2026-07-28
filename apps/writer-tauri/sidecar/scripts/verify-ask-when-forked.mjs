// Headless behavioural check for the AskUserQuestion tuning rule in CLAUDE.md:
// the model should ASK (lean toward asking) on a genuine fork whose answer
// changes the output and can't be inferred — but NOT ask for a dictated,
// trivial change. Prompt-only rule; the plumbing already exists (canUseTool
// parks AskUserQuestion under permissionMode 'default' and emits chat/permission).
//
// This drives a live sidecar in 'default' mode (so canUseTool fires) and
// watches for a chat/permission notification with toolName 'AskUserQuestion'.
//
//   CASE=fork (default) — "translate into THE OTHER language" but the profile
//                         says the user works across 3 languages → ambiguous
//                         target → EXPECT an AskUserQuestion (with options).
//   CASE=clear          — a dictated typo fix → EXPECT no AskUserQuestion.
//
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-ask-when-forked.mjs

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
const CASE = process.env.CASE === 'clear' ? 'clear' : 'fork'

if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set — cannot run the live model check.')
  process.exit(2)
}

const vault = mkdtempSync(join(tmpdir(), 'ask-fork-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })

const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')
// Profile establishes THREE languages, so "the other language" is a genuine
// fork the model cannot infer — the ideal trigger for a clarifying question.
const systemPrompt = [
  persona,
  '--- CLAUDE.md ---',
  claudeMd,
  `--- WORKSPACE ---\nThe vault root is \`${vault}\`.`,
  '--- SELF PROFILE ---\n## About\n\nA professional translator who works across Korean, English, and Japanese.',
].join('\n\n')

const prompt =
  CASE === 'clear'
    ? "Fix the typo in this sentence — change 'lanuch' to 'launch': 'The lanuch is delayed to Q3.'"
    : "Translate this note into the other language: 'The launch is delayed to Q3.'"

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

let asked = null // the AskUserQuestion input when the model asks
let assistantText = ''
notifListeners.push((msg) => {
  if (msg.method === 'chat/permission' && msg.params?.toolName === 'AskUserQuestion') {
    asked = msg.params.input
  }
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
    for (const b of msg.params.event.message?.content ?? []) {
      if (b.type === 'text' && typeof b.text === 'string') assistantText += b.text
    }
  }
})

function runChat(runId) {
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      // The turn PARKS on AskUserQuestion (no chat/done until answered), so
      // resolve as soon as we see the ask; otherwise resolve on done/error.
      if (msg.method === 'chat/permission' && msg.params?.toolName === 'AskUserQuestion') {
        resolve({ kind: 'asked' })
      } else if (msg.method === 'chat/done') resolve({ kind: 'done' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      runId,
      model: 'claude-sonnet-5',
      systemPrompt,
      prompt,
      vaultPath: vault,
      permissionMode: 'default', // so canUseTool fires and can park AskUserQuestion
      relayTools: ['propose_edit', 'propose_write', 'propose_skill', 'move_note'],
      builtinTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
      allowDelegation: false,
      sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  console.log(`  … running chat turn (case=${CASE})`)
  // The runId doubles as the SDK session id, and the CLI rejects anything that
  // isn't a UUID — "Error: Invalid session ID. Must be a valid UUID." A readable
  // literal here kills the turn before the model runs, surfacing only as an opaque
  // INTERNAL. verify-stale-retry hit this and fixed itself; the note never spread.
  const r = await runChat(globalThis.crypto.randomUUID())
  if (r.kind === 'error') bad('chat errored', JSON.stringify(r))

  if (asked) {
    const qs = asked.questions ?? []
    console.log(`\n  AskUserQuestion asked: ${JSON.stringify(qs.map((q) => ({ q: q.question, opts: (q.options ?? []).map((o) => o.label) })))}`)
  } else {
    console.log(`\n  no AskUserQuestion. reply: ${assistantText.trim().slice(0, 200)}`)
  }

  // LIVENESS, both branches. The clear-case verdict is "no question was asked",
  // which is equally true of a model that declined, errored, or never had
  // AskUserQuestion wired up at all — so on its own it proves nothing.
  const didSomething = !!asked || assistantText.trim().length > 0
  didSomething
    ? ok('the turn produced a reply or a question')
    : bad('the turn produced NEITHER — nothing was exercised, the verdict is meaningless')

  if (CASE === 'fork') {
    if (asked) {
      ok('genuine fork → model asked via AskUserQuestion')
      const opts = asked.questions?.[0]?.options ?? []
      opts.length >= 2 ? ok(`offered ${opts.length} concrete options`) : bad('asked without ≥2 options')
    } else {
      bad('genuine fork → model did NOT ask (guessed instead)')
    }
  } else {
    // POSITIVE CONTROL for the clear case. "It didn't ask" only means something
    // if it did the work — otherwise a refusal scores identically to correct
    // restraint. The dictated fix must show up in the reply.
    const didTheFix = /launch/i.test(assistantText) && !/lanuch/i.test(assistantText)
    didTheFix
      ? ok('the dictated fix was performed (typo corrected in the reply)')
      : bad('the reply does not show the correction — the model did not do the task')
    asked
      ? bad('dictated trivial fix wrongly triggered an AskUserQuestion')
      : ok('dictated trivial fix → no question (no spam)')
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
