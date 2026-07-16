// Integration probe for Stage 2: drives the REAL Server class (persistent path)
// with two `chat` requests on the same threadId and verifies one query() is
// reused across both turns (activeThreads stays size 1) and both settle with
// chat/done carrying the correct per-turn runId.
//
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   node scripts/probe-server-persistent.mjs

import { randomUUID } from 'node:crypto'
import { Server } from '../src/server.mjs'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token || !token.startsWith('sk-ant-oat')) {
  console.error('Set CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... first.')
  process.exit(2)
}

const seen = { done: [], error: [], events: 0 }
const waiters = []
function notify(method, predicate) {
  return new Promise((resolve) => waiters.push({ method, predicate, resolve }))
}

const server = new Server({
  mode: 'chat',
  emit: (msg) => {
    if (msg.method === 'chat/event') seen.events++
    if (msg.method === 'chat/done') {
      seen.done.push(msg.params)
      console.log(
        `  chat/done runId=${msg.params.runId?.slice(0, 8)} thread=${msg.params.threadId?.slice(0, 8)} stop=${msg.params.stopReason} bg=${msg.params.backgroundRequested}`,
      )
    }
    if (msg.method === 'chat/error') {
      seen.error.push(msg.params)
      console.log(`  chat/error runId=${msg.params.runId?.slice(0, 8)} code=${msg.params.code} msg=${msg.params.message}`)
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      if (msg.method === w.method && w.predicate(msg.params)) {
        waiters.splice(i, 1)
        w.resolve(msg.params)
      }
    }
  },
})

const send = (method, params, id) => server.handle({ jsonrpc: '2.0', id, method, params })

async function main() {
  send('initialize', {}, 1)
  send('setToken', { token }, 2)

  // threadId maps to the SDK sessionId, which MUST be a UUID (the real app uses
  // crypto.randomUUID() for thread ids). A non-UUID makes the CLI exit 1.
  const threadId = randomUUID()
  const runId1 = randomUUID()
  const runId2 = randomUUID()

  console.log('=== turn 1 (creates thread query) ===')
  const done1 = notify('chat/done', (p) => p.runId === runId1)
  const err1 = notify('chat/error', (p) => p.runId === runId1)
  send('chat', { runId: runId1, threadId, persistentQuery: true, prompt: 'Reply with exactly one word: apple' }, 3)
  await Promise.race([done1, err1])
  console.log(`  activeThreads.size after turn 1 = ${server.activeThreads.size} (expect 1)`)

  console.log('=== turn 2 (must REUSE the same query) ===')
  const sizeBefore = server.activeThreads.size
  const done2 = notify('chat/done', (p) => p.runId === runId2)
  const err2 = notify('chat/error', (p) => p.runId === runId2)
  send('chat', { runId: runId2, threadId, persistentQuery: true, prompt: 'Reply with exactly one word: banana' }, 4)
  await Promise.race([done2, err2])
  console.log(`  activeThreads.size after turn 2 = ${server.activeThreads.size} (expect 1, no new thread)`)

  console.log('\n================ SUMMARY ================')
  console.log(`chat/done count: ${seen.done.length} (expect 2)`)
  console.log(`chat/error count: ${seen.error.length} (expect 0)`)
  console.log(`one thread reused across both turns: ${sizeBefore === 1 && server.activeThreads.size === 1}`)
  const pass = seen.done.length === 2 && seen.error.length === 0 && server.activeThreads.size === 1
  console.log(pass ? '\nPASS: Stage 2 persistent path served 2 turns on one query().' : '\nFAIL: see above.')

  // Teardown the thread's subprocess so the process can exit.
  server.shutdown()
  setTimeout(() => process.exit(pass ? 0 : 1), 400)
}

main().catch((e) => {
  console.error('HARNESS ERROR:', e)
  process.exit(1)
})
