// Verifies the title sidecar's transport: a one-shot `claude_title` →
// `mode=title` chat, used instead of the removed anthropic_messages_create
// direct path.
//
// NAMING NOTE: this file used to say it mirrored `pipeline.ts::callSection`.
// That symbol, and `pipeline.ts` itself, no longer exist anywhere in the repo —
// the reference rotted silently while the harness kept passing, which is the
// exact hazard a hand-copy carries. The live caller of this transport today is
// `src/agent/generateThreadTitle.ts` (invokes `claude_title` at :98). This
// harness replays that call shape against a live sidecar and checks the events
// it depends on:
//   - claude:event  → { event:{ type:'assistant', message:{ content:[{type:'text',text}] } } }
//   - claude:done   → run settled ok
//   - claude:error  → { code }
//
// Two modes:
//   • No token in env  → plumbing check only: initialize handshake works and a
//     chat without a token is rejected with NO_TOKEN (proves the path is wired
//     and returns the error shape the caller maps to a fatal).
//   • CLAUDE_CODE_OAUTH_TOKEN set → full one-shot: initialize → setToken →
//     chat with a profile-style systemPrompt+prompt → assert assistant text
//     arrives and the run ends with done.
//
// Usage:
//   node scripts/verify-profile-title.mjs                 # plumbing only
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-profile-title.mjs

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN

const child = spawn('node', [SIDECAR, '--mode=title'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifs = []
const notifListeners = []

child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) {
      notifs.push(msg)
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

// Replays the caller's event handling over chat/* (the Rust bridge renames
// these to claude:* in the app). This is a REIMPLEMENTATION, not an import —
// if `generateThreadTitle.ts` changes which events it consumes or how it
// settles, this will keep passing against the old shape. Re-read it when you
// touch that file.
function runSection(runId, systemPrompt, prompt) {
  let text = ''
  return new Promise((resolve) => {
    const off = (msg) => {
      if (msg.params?.runId !== runId) return
      if (msg.method === 'chat/event') {
        const ev = msg.params.event
        if (ev?.type === 'assistant') {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && typeof b.text === 'string') text += b.text
          }
        }
      } else if (msg.method === 'chat/done') {
        resolve({ kind: text.trim() ? 'ok' : 'empty', text })
      } else if (msg.method === 'chat/error') {
        resolve({ kind: 'error', code: msg.params.code, message: msg.params.message })
      }
    }
    notifListeners.push(off)
    // The accepted-ack resolves immediately (we ignore it and wait for
    // chat/done). A pre-run failure — e.g. no token — arrives as a JSON-RPC
    // error RESPONSE, not a chat/error notification, so settle on reject too.
    request('chat', { runId, model: 'claude-haiku-4-5', systemPrompt, prompt }).catch((err) => {
      const code = err?.code === -32003 ? 'NO_TOKEN' : `RPC_${err?.code ?? '?'}`
      resolve({ kind: 'error', code, message: err?.message })
    })
  })
}

let failed = false
const ok = (label) => console.log(`  ✓ ${label}`)
const bad = (label, extra) => {
  failed = true
  console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
}

try {
  const init = await request('initialize', {})
  init?.mode === 'title' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))

  if (!TOKEN) {
    // Plumbing-only: chat without a token must be rejected as NO_TOKEN.
    const r = await runSection('plumb-1', 'You are a test.', 'ping')
    r.kind === 'error' && r.code === 'NO_TOKEN'
      ? ok('chat without token → NO_TOKEN (auth gate + error shape)')
      : bad('expected NO_TOKEN error', JSON.stringify(r))
    console.log('\n  (no token) plumbing verified. For the full LLM round-trip:')
    console.log('  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-profile-title.mjs')
  } else {
    const st = await request('setToken', { token: TOKEN })
    st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

    // A realistic profile "voice" section call: invariant (system+posts) in
    // systemPrompt, the varying instruction in prompt — the caller's mapping.
    const systemPrompt =
      'You extract a writer’s profile from their posts.\n\n' +
      '# Post 1: On shipping\nI ship small and often. Perfect is the enemy of done.'
    const prompt =
      'Describe this writer’s VOICE in 2–3 sentences. Return only the section body.'
    // runId MUST be a real UUID: the one thread engine synthesises the
    // thread/session id from it for a one-shot (title/section), and the claude
    // CLI rejects a non-UUID sessionId (exit 1). The real app always passes a
    // crypto.randomUUID() runId, so this mirrors it.
    const r = await runSection(randomUUID(), systemPrompt, prompt)
    if (r.kind === 'ok') {
      ok('full section round-trip → assistant text + done')
      console.log('\n  --- model output ---\n  ' + r.text.trim().replace(/\n/g, '\n  ') + '\n')
    } else {
      bad('section run did not return text', JSON.stringify(r))
    }
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
