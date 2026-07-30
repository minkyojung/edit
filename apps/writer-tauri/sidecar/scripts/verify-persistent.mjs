// Consolidated end-to-end verification of the persistent-query path, driving
// the REAL Server class against the REAL SDK (the same events the frontend
// consumes). Run:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   node scripts/verify-persistent.mjs
//
// Covers: (1) multi-turn reuse, (2) background survival + autonomous completion,
// (3) cancel keeps the thread, (4) mid-thread model change (no abort),
// (5) a cancel KILLS an in-flight background task — pinned SDK defect #352,
//     not the behaviour we want. See the comment inside scenario 5.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from '../src/server.mjs'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token || !token.startsWith('sk-ant-oat')) {
  console.error('Set CLAUDE_CODE_OAUTH_TOKEN first.')
  process.exit(2)
}

// Temp vault with a background:true agent for the background scenarios.
const vault = mkdtempSync(join(tmpdir(), 'octave-verify-'))
mkdirSync(join(vault, '_system/agent/.claude-plugin'), { recursive: true })
mkdirSync(join(vault, '_system/agent/agents'), { recursive: true })
writeFileSync(
  join(vault, '_system/agent/.claude-plugin/plugin.json'),
  JSON.stringify({ name: 'writer-agent-skills', version: '0.1.0', description: 'verify' }),
)
writeFileSync(
  join(vault, '_system/agent/agents/slowcounter.md'),
  `---\nname: slowcounter\ndescription: slow background count\ntools: ["Bash"]\nbackground: true\n---\nRun one Bash command: \`for i in $(seq 1 12); do echo "c $i"; sleep 1; done\` then say "done".\n`,
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

// A fresh Server per scenario keeps them independent.
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
  send('setToken', { token }, 2)
  return { server, send, ev }
}
const waitFor = async (pred, ms = 30000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(200)
  }
  return false
}

async function scenario1_multiTurn() {
  console.log('\n[1] multi-turn: one query serves 2 turns')
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'one word: apple' }, 3)
  await waitFor(() => ev.done.some((d) => d.runId === r1) || ev.err.length)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'one word: banana' }, 4)
  await waitFor(() => ev.done.some((d) => d.runId === r2) || ev.err.length)
  check('both turns done', ev.done.length === 2 && ev.err.length === 0)
  check('one query reused (activeThreads=1)', server.activeThreads.size === 1)
  send("chat/close-thread", { threadId: tid })
  await sleep(400)
}

async function scenario2_background() {
  console.log('\n[2] background: survives + autonomous completion turn')
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID()
  send('chat', {
    runId: r1, threadId: tid, persistentQuery: true, vaultPath: vault,
    builtinTools: ['Bash', 'Task'],
    prompt: 'Delegate to the slowcounter subagent via Task, then one sentence that it runs in the background. Do not wait.',
  }, 3)
  await waitFor(() => ev.done.some((d) => d.runId === r1)) // spawning turn completes
  const aliveDuringBg = server.activeThreads.size === 1
  const gotNotif = await waitFor(() => ev.task.some((t) => t.kind === 'notification' && t.outputFile), 40000)
  const gotAutonomous = await waitFor(() => ev.bgDone.length > 0, 10000)
  check('spawning turn completed', ev.done.some((d) => d.runId === r1))
  check('thread alive during background work', aliveDuringBg)
  check('task_notification with output file', gotNotif)
  check('autonomous completion turn (background chat/done)', gotAutonomous)
  send("chat/close-thread", { threadId: tid })
  await sleep(400)
}

async function scenario3_cancel() {
  console.log('\n[3] cancel: current turn CANCELLED, thread continues')
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'Write a 400-word story about a lighthouse.' }, 3)
  await sleep(1200)
  send('chat/cancel', { runId: r1 })
  await waitFor(() => ev.err.some((e) => e.runId === r1))
  const cancelled = ev.err.filter((e) => e.runId === r1)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'one word: alive' }, 4)
  await waitFor(() => ev.done.some((d) => d.runId === r2))
  check('exactly one CANCELLED', cancelled.length === 1 && cancelled[0].code === 'CANCELLED')
  check('next turn on same thread works', ev.done.some((d) => d.runId === r2))
  send("chat/close-thread", { threadId: tid })
  await sleep(400)
}

// The frontend no longer waits for CANCELLED before letting the user send —
// Stop settles the UI on the press (agent/chat/index.ts). So the next turn can
// arrive while the sidecar's cancelled turn is still unwinding, which scenario 3
// never exercised because it awaits the CANCELLED first. If the sidecar failed
// to release the turn, this one would queue behind it and never finish.
async function scenario3b_cancelThenSendImmediately() {
  console.log('\n[3b] cancel, then send WITHOUT waiting for CANCELLED')
  const { send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, prompt: 'Write a 400-word story about a lighthouse.' }, 3)
  await sleep(1200)
  send('chat/cancel', { runId: r1 })
  // No wait — this is the race the local settle introduces.
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, prompt: 'one word: alive' }, 4)
  const finished = await waitFor(() => ev.done.some((d) => d.runId === r2), 60000)
  check('the immediately-sent turn still completes', finished,
    `dones=[${ev.done.map((d) => (d.runId === r2 ? 'r2' : 'r1')).join(',')}] errs=[${ev.err.map((e) => e.code).join(',')}]`)
  check('and the cancelled turn reported CANCELLED exactly once',
    ev.err.filter((e) => e.runId === r1 && e.code === 'CANCELLED').length === 1)
  send('chat/close-thread', { threadId: tid })
  await sleep(400)
}

async function scenario4_modelChange() {
  console.log('\n[4] model change mid-thread: no abort (canonical control request)')
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', { runId: r1, threadId: tid, persistentQuery: true, model: 'claude-sonnet-5', prompt: 'one word: apple' }, 3)
  await waitFor(() => ev.done.some((d) => d.runId === r1) || ev.err.length)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, model: 'claude-haiku-4-5-20251001', prompt: 'one word: banana' }, 4)
  await waitFor(() => ev.done.some((d) => d.runId === r2) || ev.err.length)
  check('both turns done after model switch', ev.done.length === 2 && ev.err.length === 0)
  check('one query reused (no recreate/abort)', server.activeThreads.size === 1)
  send("chat/close-thread", { threadId: tid })
  await sleep(400)
}

async function scenario5_cancelKillsBackground() {
  console.log('\n[5] cancel KILLS an in-flight background task (pinned SDK defect #352)')
  const { server, send, ev } = makeServer()
  const tid = randomUUID(), r1 = randomUUID(), r2 = randomUUID()
  send('chat', {
    runId: r1, threadId: tid, persistentQuery: true, vaultPath: vault,
    builtinTools: ['Bash', 'Task'],
    prompt: 'Delegate to the slowcounter subagent via Task, then one sentence it runs in background. Do not wait.',
  }, 3)
  await waitFor(() => ev.task.some((t) => t.kind === 'started' && t.subagentType))
  const bgTaskId = ev.task.find((t) => t.kind === 'started' && t.subagentType)?.taskId
  // Let r1 SETTLE before sending r2. Without this, r2 is still sitting in the
  // turn queue when the cancel arrives, #cancelPersistentTurn sees
  // currentRunId !== runId and no-ops — so the scenario silently tested nothing.
  await waitFor(() => ev.done.some((d) => d.runId === r1), 60000)
  send('chat', { runId: r2, threadId: tid, persistentQuery: true, vaultPath: vault, builtinTools: ['Bash', 'Task'], prompt: 'Write a long essay about the sea.' }, 4)
  await waitFor(() => server.activeThreads.get(tid)?.currentRunId === r2, 30000)
  await sleep(1500)
  send('chat/cancel', { runId: r2 })
  await waitFor(() => ev.err.some((e) => e.runId === r2 && e.code === 'CANCELLED'), 30000)
  check('the cancel actually landed on the live turn', ev.err.some((e) => e.runId === r2 && e.code === 'CANCELLED'))

  // KNOWN UPSTREAM DEFECT — this asserts what the SDK currently DOES, not what
  // we want. On 0.3.187 / CLI 2.1.187, interrupt() cascades its abort into the
  // in-process background subagent and kills it (task_updated{status:'killed'}
  // → task_notification{status:'stopped'}), because the CLI links each task's
  // AbortController as a child of the turn's. Regression from 0.2.140; tracked
  // at anthropics/claude-agent-sdk-typescript#352, still open, no opt-out on
  // this version.
  //
  // Pinned deliberately: when Anthropic fixes it, the task will survive and
  // THIS CHECK WILL FAIL — that failure is the signal to delete this block,
  // restore the "background survives cancel" assertion, and revisit the
  // WARNING comment on #cancelPersistentTurn in server.mjs.
  await waitFor(() => ev.task.some((t) => t.taskId === bgTaskId && t.kind === 'notification'), 40000)
  const bgNotif = ev.task.find((t) => t.taskId === bgTaskId && t.kind === 'notification')
  check(
    'background subagent is KILLED by the cancel (known SDK defect #352)',
    bgNotif?.status === 'stopped',
    bgNotif ? `status=${bgNotif.status}` : 'no notification for the background task',
  )
  send("chat/close-thread", { threadId: tid })
  await sleep(400)
}

try {
  await scenario1_multiTurn()
  await scenario2_background()
  await scenario3_cancel()
  await scenario3b_cancelThenSendImmediately()
  await scenario4_modelChange()
  await scenario5_cancelKillsBackground()
} finally {
  rmSync(vault, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
console.log(`\n================ ${passed}/${results.length} checks passed ================`)
console.log(passed === results.length ? 'ALL PASS ✅' : 'SOME FAILED ❌')
process.exit(passed === results.length ? 0 : 1)
