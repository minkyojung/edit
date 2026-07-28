// A thread id the CLI would reject must still produce a working chat.
//
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   CLAUDE_CONFIG_DIR=$(mktemp -d) \
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   node scripts/verify-session-id.mjs
//
// WHY: `sdk.d.ts` says sessionId "Must be a valid UUID", and the CLI enforces it
// by exiting with `Error: Invalid session ID. Must be a valid UUID.` Nothing
// surfaces that — the query yields no result and the turn simply never
// finishes. FIVE harnesses in this directory ran dead that way for weeks,
// passing readable ids like `roundtrip-1`; it was only found after
// `options.stderr` was wired up and the CLI's own message came through.
//
// The app is not affected (thread ids are crypto.randomUUID()), so this pins
// the boundary rather than a user-facing bug: whatever a caller passes, the
// value that reaches the SDK is a UUID. asSessionId() coerces and warns.
//
// The CONTROL is what makes it evidence. A run with a proper UUID must succeed
// first — otherwise "the non-UUID run failed" is equally true of a broken token,
// a missing CLI, or a rate limit, and the verdict would mean nothing.
//
// Exit codes, shared by every harness here:
//   0 = PROVED the property holds
//   1 = DISPROVED it — a real failure
//   2 = COULD NOT DETERMINE — no token, or a control didn't hold.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'
import { asSessionId } from '../src/server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set.')
  process.exit(2)
}

const vault = mkdtempSync(join(tmpdir(), 'sessionid-'))
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

/** One turn on `threadId`. Resolves to how the run ENDED, not what it said —
 * the failure this pins is a turn that never completes at all. */
function chatOn(threadId) {
  return new Promise((resolve) => {
    const runId = globalThis.crypto.randomUUID()
    let replied = false
    const timer = setTimeout(() => resolve({ kind: 'hung', replied }), 90_000)
    listeners.push((m) => {
      if (m.params?.runId !== runId) return
      if (m.method === 'chat/event') replied = true
      if (m.method === 'chat/done') {
        clearTimeout(timer)
        resolve({ kind: 'done', replied })
      } else if (m.method === 'chat/error') {
        clearTimeout(timer)
        resolve({ kind: 'error', replied, code: m.params?.code, message: m.params?.message })
      }
    })
    request('chat', {
      runId,
      threadId,
      model: 'claude-haiku-4-5-20251001',
      prompt: 'Reply with exactly the word: ready',
      vaultPath: vault,
      builtinTools: [],
      relayTools: [],
      sandboxEnabled: true,
    }).catch(() => resolve({ kind: 'rejected', replied }))
  })
}

try {
  await request('initialize', {})
  await request('setToken', { token: TOKEN })

  // Assert on the product helper rather than restating the UUID rule here — a
  // hand-copied regex in a harness is how the copy drifts from the product.
  console.log('\n  --- the boundary helper ---')
  const proper = globalThis.crypto.randomUUID()
  asSessionId(proper) === proper
    ? ok('a real UUID passes through untouched')
    : bad('a real UUID was rewritten')
  const a = asSessionId('verify-session-id-probe')
  a !== 'verify-session-id-probe' && asSessionId('verify-session-id-probe') === a
    ? ok('a non-UUID is coerced, and to the same value every time (resume still lands)')
    : bad('coercion is missing or unstable', String(a))
  asSessionId('probe-x') !== asSessionId('probe-y')
    ? ok('different ids stay different (no collision into one session)')
    : bad('two different ids collapsed to one session')

  // CONTROL — a proper UUID must work here, or nothing below is attributable.
  console.log('\n  --- control: a UUID thread id ---')
  const control = await chatOn(globalThis.crypto.randomUUID())
  if (control.kind !== 'done') {
    punt(`a UUID thread id did not complete either (${control.kind})`)
    punt('so a failure on the non-UUID id would not be attributable')
  } else {
    ok('the turn completed')

    // THE ASSERTION. Before asSessionId() this hung: the CLI exited with
    // "Invalid session ID. Must be a valid UUID." and the turn never finished.
    console.log('\n  --- a non-UUID thread id ---')
    const odd = await chatOn('verify-session-id-not-a-uuid')
    odd.kind === 'done'
      ? ok('the turn completed anyway — the boundary normalised it')
      : bad(
          'the turn did not complete on a non-UUID thread id',
          `${odd.kind}${odd.code ? ` code=${odd.code}` : ''}`,
        )
  }

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  rmSync(vault, { recursive: true, force: true })
  setTimeout(() => {
    child.kill('SIGTERM')
    if (failed) console.log('\nRESULT: FAIL')
    else if (inconclusive) console.log('\nRESULT: INCONCLUSIVE (a control did not hold)')
    else console.log('\nRESULT: PASS')
    process.exit(failed ? 1 : inconclusive ? 2 : 0)
  }, 300)
}
