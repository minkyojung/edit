// How long does Stop actually take, and where does the time go?
//
// The UI leaves `status: 'streaming'` until the CANCELLED notification comes
// back (useChatRunner's catch → setStatus). So the delay a user sees is this
// round trip, not a timer. Measures each leg separately so the answer names a
// layer rather than a total:
//
//   t0  cancel notification written to the sidecar's stdin
//   t1  last chat/event before generation actually stops
//   t2  chat/error CANCELLED arrives
//
//   node scripts/measure-cancel-latency.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const SIDECAR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) { console.log('No CLAUDE_CODE_OAUTH_TOKEN set.'); process.exit(2) }

const vault = mkdtempSync(join(tmpdir(), 'cancel-latency-'))
const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'inherit'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const listeners = []
child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let m = parser.shift(); m; m = parser.shift()) {
    if (m.id !== undefined && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
      m.error ? reject(m.error) : resolve(m.result)
    } else if (m.method) for (const l of listeners) l(m)
  }
})
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }))
})
const notify = (method, params) =>
  child.stdin.write(encode({ jsonrpc: '2.0', method, params }))

const ms = (a, b) => `${(b - a).toFixed(0)}ms`

await request('initialize', {})
await request('setToken', { token: TOKEN })

const runId = globalThis.crypto.randomUUID()
let firstEventAt = null
let lastEventAt = null
let cancelSentAt = null
let cancelledAt = null
let eventsAfterCancel = 0

const finished = new Promise((resolve) => {
  listeners.push((m) => {
    if (m.params?.runId && m.params.runId !== runId) return
    const now = performance.now()
    if (m.method === 'chat/event') {
      firstEventAt ??= now
      lastEventAt = now
      if (cancelSentAt !== null) eventsAfterCancel += 1
      // Cancel once generation is genuinely under way — cancelling before the
      // model starts measures the wrong thing.
      if (cancelSentAt === null && now - firstEventAt > 1500) {
        cancelSentAt = performance.now()
        notify('chat/cancel', { runId })
      }
    } else if (m.method === 'chat/error' || m.method === 'chat/done') {
      cancelledAt = now
      resolve({ kind: m.method, code: m.params?.code })
    }
  })
})

// Long enough that the model is still going when we cancel.
request('chat', {
  runId, model: 'claude-sonnet-5', threadId: runId, persistentQuery: true,
  systemPrompt: 'You are a helpful assistant.',
  prompt: 'Count slowly from 1 to 300, one number per line, with a short remark after each.',
  vaultPath: vault, relayTools: [], builtinTools: [],
  allowDelegation: false, sandboxEnabled: false,
}).catch(() => {})

const outcome = await finished

console.log('\n── where the Stop delay goes ──')
if (cancelSentAt === null) {
  console.log('  ! never reached the cancel point — the model answered too fast')
} else {
  console.log(`  cancel written → terminal event   ${ms(cancelSentAt, cancelledAt)}   ← what the user waits`)
  console.log(`  cancel written → last chat/event  ${ms(cancelSentAt, lastEventAt)}   (generation kept going this long)`)
  console.log(`  chat/event frames after cancel    ${eventsAfterCancel}`)
  console.log(`  terminal                          ${outcome.kind}${outcome.code ? ` ${outcome.code}` : ''}`)
  console.log(
    `\n  The UI holds status:'streaming' for the FIRST number — nothing in the\n` +
    `  frontend acknowledges the press before that notification lands.`,
  )
}

await request('shutdown', {}).catch(() => {})
setTimeout(() => { child.kill('SIGTERM'); process.exit(0) }, 300)
