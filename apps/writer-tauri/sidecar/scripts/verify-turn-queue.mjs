// A turn sent while another is still answering is queued, not dropped.
//
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   CLAUDE_CONFIG_DIR=$(mktemp -d) \
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   node scripts/verify-turn-queue.mjs
//
// This is the behaviour the composer's type-ahead rests on. `#dispatchTurn`
// documents it — "strict serialization + FIFO: one turn generates at a time, in
// arrival order" — and the frontend now relies on it: PromptInput's
// submitIntent() returns 'queue' mid-answer and hands the turn straight to the
// sidecar. If the queue ever stopped serialising, two runs would write into the
// same per-thread streaming buffer at once and the transcript would interleave.
//
// Two properties, and BOTH matter:
//   1. the second chat is ACCEPTED while the first is in flight (not rejected)
//   2. it does not start producing until the first has settled
// Asserting only (1) would pass a sidecar that ran them concurrently; asserting
// only (2) would pass one that silently dropped the second.
//
// The first prompt has to be long enough to still be generating when the second
// arrives — hence "count to 40". If the model races through it anyway the run is
// INCONCLUSIVE rather than PASS: nothing was overlapped, so nothing was proved.
//
// Exit codes, shared by every harness here:
//   0 = PROVED   1 = DISPROVED   2 = COULD NOT DETERMINE

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set.')
  process.exit(2)
}

const vault = mkdtempSync(join(tmpdir(), 'turnqueue-'))
const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'ignore'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const listeners = []
child.stdout.on('data', (c) => {
  parser.push(c)
  for (let m = parser.shift(); m; m = parser.shift()) {
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    } else if (m.method) for (const f of listeners) f(m)
  }
})
const request = (method, params) =>
  new Promise((r) => {
    const id = nextId++
    pending.set(id, r)
    child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }))
  })

let failed = false
let inconclusive = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => {
  failed = true
  console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`)
}
const punt = (l) => {
  inconclusive = true
  console.log(`  ! ${l}`)
}

// Ordered log. `first-token` is when a run began PRODUCING, which is the thing
// serialisation is about — an accepted-but-parked run emits nothing.
const log = []
const settled = new Map()
listeners.push((m) => {
  const rid = m.params?.runId
  if (!rid) return
  if (m.method === 'chat/event') {
    if (!log.some((e) => e.rid === rid && e.k === 'first-token')) {
      if (/"text"/.test(JSON.stringify(m.params.event))) log.push({ k: 'first-token', rid })
    }
  } else if (m.method === 'chat/done') {
    log.push({ k: 'done', rid })
    settled.set(rid, 'done')
  } else if (m.method === 'chat/error') {
    log.push({ k: 'error', rid, code: m.params?.code })
    settled.set(rid, 'error')
  }
})

const threadId = globalThis.crypto.randomUUID()
const chat = (runId, prompt) =>
  request('chat', {
    runId,
    threadId,
    // The app's real shape: one long-lived query per thread, which is what owns
    // the queue. Without it each turn is a one-shot and there is nothing to test.
    persistentQuery: true,
    model: 'claude-haiku-4-5-20251001',
    prompt,
    vaultPath: vault,
    builtinTools: [],
    relayTools: [],
    sandboxEnabled: true,
  })

try {
  await request('initialize', {})
  await request('setToken', { token: TOKEN })

  const A = globalThis.crypto.randomUUID()
  const B = globalThis.crypto.randomUUID()

  chat(A, 'Count slowly from 1 to 40, one number per line, nothing else.')
  await new Promise((r) => setTimeout(r, 2500))

  if (settled.has(A)) {
    punt('the first turn finished before the second was sent — nothing overlapped')
  } else {
    const accepted = await chat(B, 'Reply with exactly the word: SECOND')
    accepted?.accepted === true
      ? ok('the second turn was ACCEPTED while the first was still answering')
      : bad('the second turn was refused mid-answer', JSON.stringify(accepted))

    const t0 = Date.now()
    while (settled.size < 2 && Date.now() - t0 < 180_000) {
      await new Promise((r) => setTimeout(r, 300))
    }

    console.log('\n  --- order ---')
    for (const e of log) console.log(`   ${e.k.padEnd(12)} ${e.rid === A ? 'A' : 'B'}`)

    if (settled.get(A) !== 'done' || settled.get(B) !== 'done') {
      punt(`a run did not complete (A=${settled.get(A)}, B=${settled.get(B)})`)
    } else {
      const aDone = log.findIndex((e) => e.k === 'done' && e.rid === A)
      const bFirst = log.findIndex((e) => e.k === 'first-token' && e.rid === B)
      if (bFirst === -1) punt('the second turn produced no text — cannot order it')
      else if (bFirst > aDone)
        ok('and it only started producing AFTER the first settled (serialised)')
      else bad('the two turns produced output concurrently — the queue is not serialising')
    }
  }

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  rmSync(vault, { recursive: true, force: true })
  setTimeout(() => {
    child.kill('SIGTERM')
    if (failed) console.log('\nRESULT: FAIL')
    else if (inconclusive) console.log('\nRESULT: INCONCLUSIVE')
    else console.log('\nRESULT: PASS')
    process.exit(failed ? 1 : inconclusive ? 2 : 0)
  }, 300)
}
