// Token-free verification of the persistent-path lifecycle logic changed in
// Stage A/B. Drives the REAL Server class but mocks the SDK `query()` with a
// controllable fake (no API calls), so the concurrency/lifecycle edits are
// exercised deterministically.
//
//   node --experimental-test-module-mocks verify-lifecycle.mjs
import { mock } from 'node:test'
import { randomUUID } from 'node:crypto'

const BUSY_CODE = -32001

const SIDECAR = '..'

// ── Fake query registry ──────────────────────────────────────────────
// One fake per query() call (i.e. per thread / per legacy run), in creation
// order. Each exposes: pushEvent(e), endOutput(), messages[] (pulled inputs),
// calls[] (control-request names).
const fakes = []
function makeFakeQuery(prompt, options) {
  const outQ = []
  let outResolve = null
  let outEnded = false
  const rec = { messages: [], calls: [], inputEnded: false, options, pushEvent, endOutput }
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
    // The real SDK does more than end the stream here: `streamInput` falls out
    // of its `for await`, waits for the first result, and calls
    // `transport.endInput()` — closing stdin to the CLI for good. Every control
    // request after that (canUseTool, hooks) is answered by a dead channel and
    // silently no-ops, with tools still running and no error anywhere. Recording
    // it lets T10 assert the generator never gets here.
    rec.inputEnded = true
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
    query: ({ prompt, options }) => makeFakeQuery(prompt, options),
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    createSdkMcpServer: (cfg) => ({ ...cfg }),
    getSessionInfo: async () => undefined, // missing session → create path
  },
})

const {
  Server,
  threadBusy,
  MAX_LIVE_THREADS: MAX,
  MAX_LIVE_TITLES: MAX_TITLES,
} = await import(`${SIDECAR}/src/server.mjs`)

// ── Harness ──────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(10) }
  return false
}
const errs = []
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
  const ev = { done: [], err: [], task: [], bgDone: [], event: [] }
  const server = new Server({
    mode: 'chat',
    emit: (m) => {
      // JSON-RPC error RESPONSES (a refused request), distinct from chat/error.
      if (m.error && m.id !== undefined) errs.push(m)
      if (m.method === 'chat/done') (m.params.background ? ev.bgDone : ev.done).push(m.params)
      else if (m.method === 'chat/error') ev.err.push(m.params)
      else if (m.method === 'chat/task') ev.task.push(m.params)
      else if (m.method === 'chat/event') ev.event.push(m.params)
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

// ── T5: A1 refactor — busy (active-turn) thread survives eviction ─────
async function t5() {
  console.log('\n[T5] A1: #threadBusy protects a busy thread under LRU pressure')
  fakes.length = 0
  const { server, send, ev } = makeServer()
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

// ── T7: closeAfterResult — a one-shot thread (title / any non-persistent
// flow) ends after its single result, instead of lingering like a chat. ──
async function t7() {
  console.log('\n[T7] closeAfterResult: one-shot thread tears down after its single result')
  fakes.length = 0; teardownLog.length = 0
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  // No persistentQuery → the router derives teardown:'closeAfterResult' (the
  // flag-off / intake one-shot case, now on the one engine).
  send('chat', { runId: r1, threadId: tid, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  check('thread live before result', server.activeThreads.has(tid))
  await runTurn(fake, r1, ev)
  // The single result closes the input → query ends → finalize teardown.
  await waitFor(() => !server.activeThreads.has(tid))
  check('one turn settled (chat/done)', ev.done.length === 1 && ev.err.length === 0, `done=${ev.done.length} err=${ev.err.length}`)
  check('thread torn down after one result', !server.activeThreads.has(tid), `size=${server.activeThreads.size}`)
  check('exactly one query (no reuse for a one-shot)', fakes.length === 1, `fakes=${fakes.length}`)
}

// ── T8: title mode routes onto the thread engine (B2) — a title chat (no
// threadId, no persistentQuery, exactly what generateThreadTitle sends) runs
// as a closeAfterResult one-shot on the engine, not the legacy path, and is
// capped at MAX_LIVE_TITLES rather than refused outright.
//
// This used to assert single-flight (a second concurrent title must NOT spawn a
// thread). That was the product's behaviour and it was the bug: teardown lags
// `chat/done` by seconds against the real SDK, so the cap of 1 refused the next
// new chat for that whole window and nothing retried. The window is invisible
// here — the fake query ends its output the moment input ends — which is why
// this check kept passing; `verify-thread-title` drives a real sidecar and is
// what actually covers it.
async function t8() {
  console.log('\n[T8] title mode → thread engine, closeAfterResult one-shot, capped not single-flight')
  fakes.length = 0; teardownLog.length = 0
  const ev = { done: [], err: [] }
  const server = new Server({
    mode: 'title',
    emit: (m) => {
      // JSON-RPC error RESPONSES (a refused request), distinct from chat/error.
      if (m.error && m.id !== undefined) errs.push(m)
      if (m.method === 'chat/done') ev.done.push(m.params)
      else if (m.method === 'chat/error') ev.err.push(m.params)
    },
  })
  const send = (method, params, id) => server.handle({ jsonrpc: '2.0', id, method, params })
  send('initialize', {}, 1)
  send('setToken', { token: 'sk-ant-oat-test-fake' }, 2)
  const r1 = randomUUID()
  send('chat', { runId: r1, prompt: 'summarize this' }, nid())
  const fake = await awaitFake(1)
  check(
    'title ran on the thread engine (one activeThreads entry)',
    server.activeThreads.size === 1,
    `threads=${server.activeThreads.size}`,
  )
  // The title mode supplies its own prompt + one-shot constraints, so the
  // caller sending only a message still gets them. Read off the built options:
  // an empty tools array is the SDK's "no built-in tools", NOT "unspecified".
  const opts = fake.options ?? {}
  check('title mode supplied its own system prompt', typeof opts.systemPrompt === 'string' && opts.systemPrompt.length > 0)
  check('title runs tool-less', Array.isArray(opts.tools) && opts.tools.length === 0, `tools=${JSON.stringify(opts.tools)}`)
  check('title runs single-turn', opts.maxTurns === 1, `maxTurns=${opts.maxTurns}`)

  // Capped, not single-flight: concurrent titles up to MAX_LIVE_TITLES are
  // accepted (the previous new chat's thread has not drained yet), and only the
  // one past the cap is refused.
  const extras = []
  for (let i = 1; i < MAX_TITLES; i++) {
    const r = randomUUID()
    extras.push(r)
    send('chat', { runId: r, prompt: `other ${i}` }, nid())
  }
  const fakes2 = []
  for (let i = 1; i < MAX_TITLES; i++) fakes2.push(await awaitFake(i + 1))
  check(
    `titles run concurrently up to the cap (${MAX_TITLES})`,
    server.activeThreads.size === MAX_TITLES,
    `threads=${server.activeThreads.size}`,
  )
  errs.length = 0
  send('chat', { runId: randomUUID(), prompt: 'one too many' }, nid())
  check('one past the cap is refused, not spawned', server.activeThreads.size === MAX_TITLES && errs.length === 1,
    `threads=${server.activeThreads.size} errs=${errs.length}`)
  check('and the refusal is a retryable BUSY', errs[0]?.error?.code === BUSY_CODE, JSON.stringify(errs[0]?.error))

  await runTurn(fake, r1, ev)
  for (let i = 0; i < extras.length; i++) await runTurn(fakes2[i], extras[i], ev)
  await waitFor(() => server.activeThreads.size === 0)
  check('every title thread torn down after its single result', server.activeThreads.size === 0, `threads=${server.activeThreads.size}`)
  check(`${MAX_TITLES} chat/done, no error`, ev.done.length === MAX_TITLES && ev.err.length === 0, `done=${ev.done.length} err=${ev.err.length}`)
}

// ── T9: background work decides whether a thread may be reaped/evicted ────
// The predicate that decides whether a subprocess lives or dies, driven by
// synthetic `background_tasks_changed` events — no API calls, no waiting out
// IDLE_TTL_MS, and deterministic. Until now nothing covered this: the only
// #threadBusy test (T5) exercises the `turnActive` leg, and the real-model
// script covers the set but never the reap decision itself.
async function t9() {
  console.log('\n[T9] background_tasks_changed drives threadBusy (REPLACE semantics)')
  fakes.length = 0
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'x' }, nid())
  const f = await awaitFake(1)
  await runTurn(f, r1, ev)
  const rec = server.activeThreads.get(tid)
  check('idle thread is not busy', !threadBusy(rec))

  // A background task appears.
  f.pushEvent({ type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg1', task_type: 'local_agent', description: 'work' }] })
  await waitFor(() => rec.backgroundTaskIds.size === 1)
  check('live background work makes the thread busy', threadBusy(rec))

  // REPLACE, not merge: a payload naming a different task must not accumulate.
  f.pushEvent({ type: 'system', subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bg2', task_type: 'local_bash', description: 'other' }] })
  await waitFor(() => rec.backgroundTaskIds.has('bg2'))
  check('a later payload REPLACES the set (no accumulation)',
    rec.backgroundTaskIds.size === 1 && !rec.backgroundTaskIds.has('bg1'),
    `set=${[...rec.backgroundTaskIds]}`)

  // Empty payload = nothing live. This is the leg that used to latch.
  f.pushEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  await waitFor(() => rec.backgroundTaskIds.size === 0)
  check('empty payload clears it and the thread is reapable', !threadBusy(rec))

  // A blocking subagent emits task_started and never a terminal. It must not
  // reach the set — that edge-pairing was the original leak.
  f.pushEvent({ type: 'system', subtype: 'task_started', task_id: 'fg1',
    description: 'blocking', subagent_type: 'plugin:counter' })
  await sleep(50)
  check('a bare task_started does NOT make the thread busy', !threadBusy(rec),
    `set=${[...rec.backgroundTaskIds]}`)

  // …but it must still reach the UI channel.
  check('task_started still forwards on chat/task',
    ev.task.some((t) => t.kind === 'started' && t.taskId === 'fg1'))
}

// ── T10: the prompt generator must never finish ──────────────────────────
// The thread's input iterable (#threadInput) loops forever and parks between
// turns. That is load-bearing, not stylistic: the SDK's `streamInput` closes
// stdin once the iterable returns (it awaits the first result, then calls
// transport.endInput), and `hasBidirectionalNeeds()` is true for us because we
// always pass canUseTool and a relay MCP server. With stdin gone, every control
// request is answered by a dead channel — the AskUserQuestion gate stops
// parking turns and the model answers its own question, with no error and tools
// still working. Nothing about that looks broken from the outside.
//
// So the cheap net lives here, on the fake: assert the generator is still
// pending after turns settle. A refactor to per-turn `query.streamInput()` —
// which the SDK's own docs make look reasonable — trips this immediately,
// without an API call.
async function t10() {
  console.log('\n[T10] the prompt generator parks forever (stdin stays open)')
  fakes.length = 0
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()

  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'one' }, nid())
  const f = await awaitFake(1)
  await runTurn(f, r1, ev)
  check('generator still pending after turn 1 settles', f.inputEnded === false)

  // A second turn on the same thread — the case that would already be broken if
  // the generator had finished, since its message could not be delivered.
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'two' }, nid())
  await waitFor(() => f.messages.length >= 2)
  check('turn 2 reached the same live query', f.messages.length >= 2, `messages=${f.messages.length}`)
  await runTurn(f, r2, ev)
  check('generator still pending after turn 2', f.inputEnded === false)
  check('one query served both turns', server.activeThreads.size === 1)

  // Closing the thread is the ONLY thing that may end it.
  send('chat/close-thread', { threadId: tid })
  await waitFor(() => f.inputEnded === true, 3000)
  check('closing the thread does end the generator', f.inputEnded === true)
}

// ── T11: a turn queued behind a live one must not be stranded by teardown ──
// #dispatchTurn already refuses to queue onto a dead thread, and its comment
// names the failure exactly: "its runId is already in runToThread ... with no
// terminal → frontend wedge". #teardownThread had the same hazard from the
// other side — it kills the thread WITH turns still in rec.turnQueue and never
// answers them. Reachable two ways: chat/close-thread while a turn is queued
// (archiveThread does abort-then-close in one tick), and the cancel path's
// PERSIST_INTERRUPT_GRACE_MS escalation to teardown('cancel_wedged').
async function t11() {
  console.log('\n[T11] closing a thread answers the turns still queued behind the live one')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  // Turn 1 goes live and STAYS live — we never push its `result`.
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length >= 1)
  // Turn 2 lands while turn 1 is active, so it sits in rec.turnQueue.
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'b' }, nid())
  await sleep(30)
  send('chat/close-thread', { threadId: tid })
  await sleep(80)
  const answered = ev.err.some((e) => e.runId === r2) || ev.done.some((d) => d.runId === r2)
  check('the queued turn is answered, not silently dropped', answered,
    `errs=[${ev.err.map((e) => e.code).join(',')}] dones=${ev.done.length}`)
  // Retryable, so the frontend re-sends on a fresh thread rather than showing a
  // dead end — the same verdict #dispatchTurn gives its own dead-thread case.
  const t = ev.err.find((e) => e.runId === r2)
  check('and told it may retry', t?.retryable === true, `retryable=${t?.retryable}`)
}

// ── T12: the cancel path's grace-window escalation, same question ──────
// #cancelPersistentTurn interrupts, then after PERSIST_INTERRUPT_GRACE_MS
// escalates to teardown('cancel_wedged') if the turn is still live. The fake
// query's interrupt() does nothing, so this is the wedged path exactly.
async function t12() {
  console.log('\n[T12] a wedged cancel escalates to teardown — the queued turn still gets answered')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length >= 1)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'b' }, nid())
  await sleep(30)
  send('chat/cancel', { runId: r1 })
  // Past the 5s grace, so the escalation to teardown has definitely run.
  await waitFor(() => ev.err.some((e) => e.runId === r2) || ev.done.some((d) => d.runId === r2), 8000)
  check('the queued turn is answered after a wedged cancel',
    ev.err.some((e) => e.runId === r2) || ev.done.some((d) => d.runId === r2),
    `errs=[${ev.err.map((e) => `${e.runId === r2 ? 'r2:' : 'r1:'}${e.code}`).join(',')}] dones=${ev.done.length}`)
  // The cancelled turn itself is answered — that path already worked; what was
  // missing is everything behind it.
  check('and the cancelled turn still reports CANCELLED',
    ev.err.some((e) => e.runId === r1 && e.code === 'CANCELLED'))
}

// ── T13: a cancel that overtakes its own chat frame ────────────────────
// The host writes `chat` only after a keychain read and a full `setToken`
// round trip, while `claude_chat_cancel` writes immediately — so a Stop
// pressed early reaches the sidecar FIRST. #handleCancel resolves runId
// through runToThread, which is only populated when `chat` is handled, so the
// early cancel no-ops and the run starts unstoppable. This pins the sidecar
// half of the contract: an out-of-order cancel is a no-op (not a crash, not a
// tombstone), which is exactly why the HOST has to re-send after the start
// resolves (agent/chat/index.ts, after `claude_chat_start`).
async function t13() {
  console.log('\n[T13] a cancel arriving before its chat frame no-ops — the host must re-send')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  // Stop pressed while the host is still doing setToken: cancel lands first.
  send('chat/cancel', { runId: r1 })
  await sleep(10)
  check('an unknown runId is a silent no-op, not an error', ev.err.length === 0,
    `errs=[${ev.err.map((e) => e.code).join(',')}]`)
  // Now the chat frame finally goes out; the run is live and NOT cancelled.
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length >= 1)
  check('the run really did start despite the earlier cancel', fake.messages.length >= 1)
  // The host's re-send is what actually stops it.
  send('chat/cancel', { runId: r1 })
  await waitFor(() => ev.err.some((e) => e.runId === r1 && e.code === 'CANCELLED'), 8000)
  check('a cancel sent after the run is registered does stop it',
    ev.err.some((e) => e.runId === r1 && e.code === 'CANCELLED'),
    `errs=[${ev.err.map((e) => e.code).join(',')}]`)
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T14: a live control changed while a turn is active must not be dropped ──
// #handleChatPersistent reconciles model/permissionMode/fastMode/effort only
// `&& !existing.turnActive` (server.mjs:590), so a turn that arrives mid-answer
// runs on the thread's OLD controls, silently. Stop → switch to plan → send is
// the reachable path, and plan mode's teeth ARE permissionMode — so the turn
// the user made read-only can still write.
//
// Note the asymmetry this pins: #warnFrozenParamChange runs unconditionally so
// a FROZEN param never changes in silence. The live-control case had no signal
// at all.
async function t14() {
  console.log('\n[T14] a model change sent mid-turn reaches the query when the turn settles')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, model: 'claude-sonnet-5', prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length >= 1)
  // Turn 2 changes the model while turn 1 is still generating.
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, model: 'claude-opus-4-8', prompt: 'b' }, nid())
  await sleep(30)
  check('nothing is applied while the turn is still live',
    !fake.calls.includes('setModel'), `calls=[${fake.calls.join(',')}]`)
  // Settle turn 1; the queued turn is about to run.
  fake.pushEvent({ type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: {}, total_cost_usd: 0 })
  await waitFor(() => fake.messages.length >= 2, 5000)
  check('the change is applied before the next turn runs',
    fake.calls.includes('setModel'), `calls=[${fake.calls.join(',')}]`)
  // And it must not be applied twice — the reconcile is consumed, not sticky.
  fake.pushEvent({ type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: {}, total_cost_usd: 0 })
  await waitFor(() => ev.done.some((d) => d.runId === r2), 5000)
  check('applied exactly once', fake.calls.filter((c) => c === 'setModel').length === 1,
    `calls=[${fake.calls.join(',')}]`)
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T15: subagent token deltas must not ride the firehose ──────────────
// With forwardSubagentText on, each subagent message ALSO arrives whole as a
// `type:'assistant'` event carrying parent_tool_use_id, and that is what builds
// the subagent lane (streamParser.ts:421-452). The per-token stream_events with
// a parent id are therefore redundant — streamParser.ts:183 drops them, but only
// after they crossed the pipe, a full serde_json::Value tree, one app.emit per
// window, and zod. Filter at the source.
//
// The trap this also pins: #isContentEvent counts stream_event when minting
// bgTurnRunId, so a filter placed BEFORE that check would break
// background-turn detection.
async function t15() {
  console.log('\n[T15] subagent stream_events are dropped at the source, main-thread ones are not')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await waitFor(() => fake.messages.length >= 1)
  const before = ev.event.length

  fake.pushEvent({ type: 'stream_event', parent_tool_use_id: 'toolu_sub', event: { delta: 'x' } })
  await sleep(30)
  check('a subagent stream_event is not forwarded', ev.event.length === before,
    `events=${ev.event.length - before}`)

  fake.pushEvent({ type: 'stream_event', parent_tool_use_id: null, event: { delta: 'y' } })
  await waitFor(() => ev.event.length > before)
  check("the main thread's own stream_event still is", ev.event.length === before + 1)

  // The subagent LANE's supplier must survive — this is the event the frontend
  // actually builds subagent rows from.
  fake.pushEvent({ type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { content: [] } })
  await waitFor(() => ev.event.length > before + 1)
  check('an assistant event with a parent id still is', ev.event.length === before + 2)

  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T16: the filter must not break background-turn detection ───────────
// bgTurnRunId is minted by #isContentEvent, which counts stream_event. A
// main-thread stream_event arriving BETWEEN turns must still mint it.
async function t16() {
  console.log('\n[T16] a between-turns stream_event still opens a background turn')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await runTurn(fake, r1, ev)
  // Turn settled → turnActive false. A content event now is an autonomous
  // background-completion turn.
  fake.pushEvent({ type: 'stream_event', parent_tool_use_id: null, event: { delta: 'z' } })
  await waitFor(() => ev.event.some((e) => e.background === true))
  const bg = ev.event.find((e) => e.background === true)
  check('it is tagged background with a synthetic runId',
    !!bg && typeof bg.runId === 'string' && bg.runId !== r1, `runId=${bg?.runId}`)
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T16b: the filter's placement, pinned by the one observable difference ──
// A SUBAGENT stream_event between turns is dropped, but it still passes through
// #isContentEvent first and mints bgTurnRunId. That matters because chat/task
// reads bgTurnRunId (server.mjs:1593) — so a task event arriving in the window
// before any surviving content event carries the synthetic runId rather than
// null. Filtering before the mint would make it null.
//
// This replaces a claim I made and could not support: I first wrote that
// filtering early would "break background-turn detection". It would not — the
// whole-message `assistant` event is a content event too and mints on its own.
// The real difference is narrower, and this is it.
async function t16b() {
  console.log('\n[T16b] a dropped subagent event still mints the background runId for chat/task')
  fakes.length = 0
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'a' }, nid())
  const fake = await awaitFake(1)
  await runTurn(fake, r1, ev)
  // Between turns. This is filtered out of chat/event, but not out of the mint.
  fake.pushEvent({ type: 'stream_event', parent_tool_use_id: 'toolu_sub', event: { delta: 'x' } })
  await sleep(30)
  const taskBefore = ev.task.length
  fake.pushEvent({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'd' })
  await waitFor(() => ev.task.length > taskBefore)
  const t = ev.task[ev.task.length - 1]
  check('the task event carries the synthetic runId, not null',
    typeof t?.runId === 'string' && t.runId !== r1, `runId=${t?.runId}`)
  send('chat/close-thread', { threadId: tid }); await sleep(50)
}

// ── T17: the thread cap is a real bound, not an advisory one ───────────
// #maybeEvictLRU only ever evicts an IDLE, background-free thread. When every
// live thread is busy it finds no victim, and #ensureThread used to build one
// more anyway — each thread is a `claude` CLI subprocess, measured at ~436MB.
//
// The refusal is deliberately narrow, and that narrowness is what makes it
// acceptable: switching between many chats leaves them idle, so eviction
// silently makes room and the user never sees this. It fires only when MAX
// threads are ALL generating or holding background work.
async function t17() {
  console.log('\n[T17] with every thread busy, one more is refused rather than spawned')
  fakes.length = 0
  const { server, send, ev } = makeServer()
  const tids = []
  // Fill to MAX with threads that never settle — all busy.
  for (let i = 0; i < MAX; i++) {
    const tid = randomUUID()
    tids.push(tid)
    send('chat', { runId: randomUUID(), threadId: tid, persistentQuery: true, prompt: 'x' }, nid())
    const f = await awaitFake(i + 1)
    await waitFor(() => f.messages.length >= 1)
  }
  check(`${MAX} live threads, all busy`, server.activeThreads.size === MAX,
    `size=${server.activeThreads.size}`)

  const overflowId = nid()
  send('chat', { runId: randomUUID(), threadId: randomUUID(), persistentQuery: true, prompt: 'y' }, overflowId)
  await sleep(80)
  check('no extra subprocess was created', server.activeThreads.size === MAX,
    `size=${server.activeThreads.size} fakes=${fakes.length}`)
  const refusal = errs.find((e) => e.id === overflowId)
  check('the caller is told, with a retryable BUSY', !!refusal && refusal.error?.code === BUSY_CODE,
    `err=${JSON.stringify(refusal?.error ?? null)}`)
  check('and the reason names what to do',
    /busy|finish|stop/i.test(refusal?.error?.message ?? ''), refusal?.error?.message)

  for (const tid of tids) send('chat/close-thread', { threadId: tid })
  await sleep(80)
}

try {
  await t1(); await t2(); await t3(); await t5(); await t6(); await t7(); await t8(); await t9(); await t10(); await t11(); await t12(); await t13(); await t14(); await t15(); await t16(); await t16b(); await t17()
} finally {
  process.stderr.write = origWrite
}
const passed = results.filter((r) => r.ok).length
console.log(`\n================ ${passed}/${results.length} checks passed ================`)
console.log(passed === results.length ? 'ALL PASS ✅' : 'SOME FAILED ❌')
process.exit(passed === results.length ? 0 : 1)
