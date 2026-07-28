// Does changing the effort dropdown mid-conversation actually reach the model?
//
// Drives the REAL Server the way the app does — one persistent thread, a second
// turn carrying a different `effort` — and reads back the level the model
// actually ran at.
//
// Why it needed fixing: the SDK has setModel and setPermissionMode but no
// setEffort, which reads as "effort is fixed for the session". It isn't —
// `Settings.effortLevel` is the knob and `applyFlagSettings` reaches it on a
// live query. The sidecar was already calling applyFlagSettings for fastMode
// and simply never included effortLevel, so the dropdown silently did nothing
// after turn 1.
//
// How it's measured: sdk.d.ts documents the active level as exposed "to hook
// commands and Bash as the CLAUDE_EFFORT env var", so each turn runs one echo
// and we read the tool result. That is the resolved value for the turn that
// actually ran — no inferring from how much the model appeared to think.
// (Hooks look like the tidier probe but are unusable here: PreToolUse and Stop
// fire only on the FIRST turn of a streaming session — measured, and the same
// with no applyFlagSettings call, so it isn't caused by this change.)
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-effort-midthread.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from '../src/server.mjs'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token || !token.startsWith('sk-ant-oat')) {
  console.error('Set CLAUDE_CODE_OAUTH_TOKEN first.')
  process.exit(2)
}

const vault = mkdtempSync(join(tmpdir(), 'effort-verify-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (name, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const readings = []
const ev = { done: [], err: [] }
const server = new Server({
  mode: 'chat',
  emit: (m) => {
    if (m.method === 'chat/done') ev.done.push(m.params)
    else if (m.method === 'chat/error') ev.err.push(m.params)
    else if (m.method === 'chat/event' && m.params?.event?.type === 'user') {
      for (const b of m.params.event.message?.content ?? []) {
        const text = typeof b?.content === 'string' ? b.content : JSON.stringify(b?.content ?? '')
        const hit = /EFFORT_(\d)=(\w*)/.exec(text)
        if (hit) readings.push({ turn: Number(hit[1]), level: hit[2] || '(empty)' })
      }
    }
  },
})
const send = (method, params, id) => server.handle({ jsonrpc: '2.0', id, method, params })
const waitFor = async (pred, ms = 180000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(200)
  }
  return false
}

const threadId = randomUUID()
const ask = (n) => `Run this exact bash command, then reply with only its output: echo "EFFORT_${n}=$CLAUDE_EFFORT"`
const turn = async (n, effort) => {
  const runId = randomUUID()
  send('chat', {
    runId,
    threadId,
    persistentQuery: true,
    vaultPath: vault,
    model: 'claude-sonnet-5',
    effort,
    builtinTools: ['Bash'],
    relayTools: [],
    allowDelegation: false,
    sandboxEnabled: false,
    prompt: ask(n),
  }, 10 + n)
  const done = await waitFor(() => ev.done.some((d) => d.runId === runId) || ev.err.some((e) => e.runId === runId))
  if (!done) console.log(`  (turn ${n} timed out)`)
  return readings.find((r) => r.turn === n)?.level
}

try {
  send('initialize', {}, 1)
  send('setToken', { token }, 2)

  console.log('\n  … turn 1 at effort=low')
  const t1 = await turn(1, 'low')
  console.log(`    → CLAUDE_EFFORT=${t1 ?? '(not read)'}`)
  check('turn 1 runs at the requested effort', t1 === 'low', `got ${t1}`)

  console.log('\n  … turn 2 on the SAME thread, effort raised to high')
  const t2 = await turn(2, 'high')
  console.log(`    → CLAUDE_EFFORT=${t2 ?? '(not read)'}`)
  check(
    'turn 2 picks up the new effort (the regression)',
    t2 === 'high',
    t2 === 'low' ? 'still low — the change never reached the model' : `got ${t2}`,
  )

  // Down as well as up: a one-way check would pass on a stuck "always high".
  console.log('\n  … turn 3, effort lowered back to low')
  const t3 = await turn(3, 'low')
  console.log(`    → CLAUDE_EFFORT=${t3 ?? '(not read)'}`)
  check('effort can be lowered again', t3 === 'low', `got ${t3}`)

  check('one thread served all three turns', server.activeThreads.size === 1)

  send('chat/close-thread', { threadId })
  await sleep(400)
} catch (err) {
  check('harness threw', false, err?.message ?? String(err))
} finally {
  rmSync(vault, { recursive: true, force: true })
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exit(failed ? 1 : 0)
}
