// Token-free verification of the persistent-path lifecycle logic changed in
// Stage A/B. Drives the REAL Server class but mocks the SDK `query()` with a
// controllable fake (no API calls), so the concurrency/lifecycle edits are
// exercised deterministically.
//
//   node --experimental-test-module-mocks verify-lifecycle.mjs
import { mock } from 'node:test'
import { randomUUID } from 'node:crypto'

const SIDECAR = '..'

// ── Fake query registry ──────────────────────────────────────────────
// One fake per query() call (i.e. per thread / per legacy run), in creation
// order. Each exposes: pushEvent(e), endOutput(), messages[] (pulled inputs),
// calls[] (control-request names).
const fakes = []
function makeFakeQuery(prompt) {
  const outQ = []
  let outResolve = null
  let outEnded = false
  const rec = { messages: [], calls: [], pushEvent, endOutput }
  function pushEvent(e) {
    if (outResolve) { const r = outResolve; outResolve = null; r({ value: e, done: false }) }
    else outQ.push(e)
  }
  function endOutput() {
    outEnded = true
    if (outResolve) { const r = outResolve; outResolve = null; r({ value: undefined, done: true }) }
  }
  // Drive the input generator (the Server's #threadInput / #runChat makeInput):
  // pull one user message per turn; blocks between turns exactly like the SDK.
  ;(async () => {
    const it = prompt[Symbol.asyncIterator]()
    try {
      while (true) {
        const { value, done } = await it.next()
        if (done) break
        rec.messages.push(value)
      }
    } catch { /* input aborted */ }
    endOutput() // input ended → stream ends (mirrors the SDK)
  })()
  const iter = {
    [Symbol.asyncIterator]() { return this },
    next() {
      if (outQ.length) return Promise.resolve({ value: outQ.shift(), done: false })
      if (outEnded) return Promise.resolve({ value: undefined, done: true })
      return new Promise((res) => { outResolve = res })
    },
    interrupt: async () => { rec.calls.push('interrupt') },
    setModel: async () => { rec.calls.push('setModel') },
    setPermissionMode: async () => { rec.calls.push('setPermissionMode') },
    applyFlagSettings: async () => { rec.calls.push('applyFlagSettings') },
    getContextUsage: async () => ({ totalTokens: 1, maxTokens: 1000 }),
    stopTask: async () => { rec.calls.push('stopTask') },
    supportedModels: async () => [],
  }
  rec.iter = iter
  fakes.push(rec)
  return iter
}

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: ({ prompt }) => makeFakeQuery(prompt),
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createSdkMcpServer: (cfg) => ({ ...cfg }),
    getSessionInfo: async () => undefined, // missing session → create path
  },
})

const { Server } = await import(`${SIDECAR}/src/server.mjs`)

// ── Harness ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(10) }
  return false
}
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok }); console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

const teardownLog = []
const origWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (s, ...a) => {
  const str = String(s)
  if (str.includes('thread-teardown')) teardownLog.push(str.trim())
  return true // swallow sidecar stderr noise during the run
}

function makeServer() {
  const ev = { done: [], err: [], task: [], bgDone: [] }
  const server = new Server({
    mode: 'chat',
    emit: (m) => {
      if (m.method === 'chat/done') (m.params.background ? ev.bgDone : ev.done).push(m.params)
      else if (m.method === 'chat/error') ev.err.push(m.params)
      else if (m.method === 'chat/task') ev.task.push(m.params)
    },
  })
  const send = (method, params, id) => server.handle({ jsonrpc: '2.0', id, method, params })
  send('initialize', {}, 1)
  send('setToken', { token: 'sk-ant-oat-test-fake' }, 2)
  return { server, send, ev }
}
// Wait for the Nth fake query to be created (query() runs after an async
// #buildThreadOptions, so it isn't available synchronously after send()).
async function awaitFake(n) {
  await waitFor(() => fakes.length >= n)
  return fakes[n - 1]
}
// Drive one persistent turn on `fake` to a clean `result` (as the SDK would).
async function runTurn(fake, runId, ev) {
  await waitFor(() => fake.messages.length > (fake.__seen ?? 0))
  fake.__seen = (fake.__seen ?? 0) + 1
  fake.pushEvent({ type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: {}, total_cost_usd: 0 })
  await waitFor(() => ev.done.some((d) => d.runId === runId) || ev.err.some((e) => e.runId === runId))
  return fake
}

let idc = 100
const nid = () => `id${idc++}`

// ── T1: multi-turn reuse — one fake query serves 2 turns ──────────────
async function t1() {
  console.log('\n[T1] multi-turn: one query reused, both turns settle')
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await runTurn(fake, r1, ev)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'b' }, nid())
  await runTurn(fake, r2, ev)
  check('both turns done', ev.done.length === 2 && ev.err.length === 0, `done=${ev.done.length} err=${ev.err.length}`)
  check('one query reused (activeThreads=1)', server.activeThreads.size === 1)
  check('exactly one fake query created', fakes.length === 1, `fakes=${fakes.length}`)
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T2: A2 rate-limit fail-fast — reject mid-turn → single RATE_LIMIT ──
async function t2() {
  console.log('\n[T2] A2: rate-limit rejected mid-turn → fail-fast, no double-emit')
  fakes.length = 0
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'long' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length > 0)
  fake.pushEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 } })
  await waitFor(() => ev.err.some((e) => e.runId === r1))
  check('one RATE_LIMIT error', ev.err.filter((e) => e.runId === r1 && e.code === 'RATE_LIMIT').length === 1)
  check('interrupt() called on the live query', fake.calls.includes('interrupt'))
  // The interrupt's eventual result must NOT double-emit.
  fake.pushEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] })
  await sleep(100)
  check('no chat/done after fail-fast', ev.done.length === 0)
  check('still exactly one error (no double emit)', ev.err.filter((e) => e.runId === r1).length === 1, `err=${ev.err.length}`)
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T3: A3 finally guard — result-less stream close → INTERNAL ────────
async function t3() {
  console.log('\n[T3] A3: stream ends mid-turn with no result → defensive INTERNAL')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'x' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length > 0)
  fake.endOutput() // close the output stream WITHOUT a result while the turn is active
  await waitFor(() => ev.err.some((e) => e.runId === r1))
  const errs = ev.err.filter((e) => e.runId === r1)
  check('one INTERNAL error emitted (no wedge)', errs.length === 1 && errs[0].code === 'INTERNAL', `codes=${errs.map((e) => e.code)}`)
  check('marked retryable', errs[0]?.retryable === true)
  await sleep(50)
}

// ── T4: B1 rollback — legacy entry tears down the live persistent thread
async function t4() {
  console.log('\n[T4] B1: legacy chat on a live thread → persistent thread torn down (flag_rollback)')
  fakes.length = 0; teardownLog.length = 0
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await runTurn(fake, r1, ev)
  const rec = server.activeThreads.get(tid)
  check('persistent thread live before rollback', !!rec && !rec.dead)
  // Flag flipped OFF: same threadId now arrives on the legacy path.
  send('chat', { runId: r2, threadId: tid, prompt: 'b' /* persistentQuery omitted */ }, nid())
  check('persistent thread torn down synchronously', !!rec && rec.dead === true)
  check('teardown reason = flag_rollback', teardownLog.some((l) => l.includes('flag_rollback')), teardownLog.join(' | '))
  // unblock the legacy fake query so nothing hangs
  const legacyFake = await awaitFake(2)
  await waitFor(() => legacyFake.messages.length > 0, 500)
  legacyFake.pushEvent({ type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: {} })
  await sleep(80)
}

// ── T5: A1 refactor — busy (active-turn) thread survives eviction ─────
async function t5() {
  console.log('\n[T5] A1: #threadBusy protects a busy thread under LRU pressure')
  fakes.length = 0
  const { server, send, ev } = makeServer()
  const MAX = 6
  const idle = []
  for (let i = 0; i < MAX - 1; i++) {
    const tid = randomUUID(), r = randomUUID()
    send('chat', { runId: r, threadId: tid, persistentQuery: true, prompt: 'x' }, nid())
    const f = await awaitFake(i + 1)
    await runTurn(f, r, ev) // settle → idle (turnActive=false, no queue)
    idle.push(tid)
  }
  // One BUSY thread: dispatch a turn, let it become active, but never settle it.
  const busyTid = randomUUID(), busyR = randomUUID()
  send('chat', { runId: busyR, threadId: busyTid, persistentQuery: true, prompt: 'busy' }, nid())
  const busyFake = await awaitFake(MAX)
  await waitFor(() => busyFake.messages.length > 0) // turnActive now true
  check('at MAX live threads', server.activeThreads.size === MAX, `size=${server.activeThreads.size}`)
  // A 7th thread triggers #maybeEvictLRU.
  const extraTid = randomUUID(), extraR = randomUUID()
  send('chat', { runId: extraR, threadId: extraTid, persistentQuery: true, prompt: 'extra' }, nid())
  await sleep(50)
  const busyRec = server.activeThreads.get(busyTid)
  check('busy thread NOT evicted', !!busyRec && busyRec.dead !== true)
  const someIdleEvicted = idle.some((t) => { const r = server.activeThreads.get(t); return !r || r.dead })
  check('an idle thread was evicted under pressure', someIdleEvicted)
}

// ── T6: model change mid-thread → live control request, no recreate ───
async function t6() {
  console.log('\n[T6] model change mid-thread → setModel on live query (no recreate)')
  fakes.length = 0
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, model: 'claude-sonnet-5', prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await runTurn(fake, r1, ev)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, model: 'claude-haiku-4-5-20251001', prompt: 'b' }, nid())
  await runTurn(fake, r2, ev)
  check('both turns done', ev.done.length === 2 && ev.err.length === 0)
  check('one query reused (no recreate)', fakes.length === 1 && server.activeThreads.size === 1, `fakes=${fakes.length}`)
  check('setModel issued on live query', fake.calls.includes('setModel'))
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

try {
  await t1(); await t2(); await t3(); await t4(); await t5(); await t6()
} finally {
  process.stderr.write = origWrite
}
const passed = results.filter((r) => r.ok).length
console.log(`\n================ ${passed}/${results.length} checks passed ================`)
console.log(passed === results.length ? 'ALL PASS ✅' : 'SOME FAILED ❌')
process.exit(passed === results.length ? 0 : 1)
