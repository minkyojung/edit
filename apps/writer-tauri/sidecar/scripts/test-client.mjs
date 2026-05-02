// Minimal test client. Spawns the sidecar, walks through PROTOCOL.md scenarios,
// and prints a pass/fail report. Used for Phase 2.3 verification before
// wiring up the Rust bridge.
//
// Usage:
//   export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
//   cd apps/writer-tauri/sidecar
//   node scripts/test-client.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')

const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) {
  console.error('ERROR: CLAUDE_CODE_OAUTH_TOKEN not set')
  process.exit(1)
}

// --- tiny RPC client over a child process ---

class Client {
  constructor(child) {
    this.child = child
    this.parser = new FrameParser()
    this.nextId = 1
    this.pending = new Map() // id -> { resolve, reject }
    this.events = [] // captured notifications
    this.eventListeners = []

    child.stdout.on('data', (chunk) => {
      this.parser.push(chunk)
      while (true) {
        const msg = this.parser.shift()
        if (!msg) break
        this.#dispatch(msg)
      }
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[sidecar stderr] ${chunk}`)
    })
    child.on('exit', (code) => {
      this.exitCode = code
      for (const [, p] of this.pending) p.reject(new Error(`sidecar exited ${code}`))
      this.pending.clear()
    })
  }

  #dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
      else p.resolve(msg.result)
    } else if (msg.method) {
      this.events.push(msg)
      for (const listener of this.eventListeners) listener(msg)
    }
  }

  request(method, params) {
    const id = this.nextId++
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(encode(msg))
    })
  }

  notify(method, params) {
    const msg = { jsonrpc: '2.0', method, params }
    this.child.stdin.write(encode(msg))
  }

  onEvent(fn) {
    this.eventListeners.push(fn)
  }

  async waitForNotification(method, predicate, timeoutMs = 30000) {
    const existing = this.events.find((e) => e.method === method && (!predicate || predicate(e.params)))
    if (existing) return existing.params
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.eventListeners = this.eventListeners.filter((l) => l !== listener)
        reject(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      const listener = (msg) => {
        if (msg.method === method && (!predicate || predicate(msg.params))) {
          clearTimeout(t)
          this.eventListeners = this.eventListeners.filter((l) => l !== listener)
          resolve(msg.params)
        }
      }
      this.eventListeners.push(listener)
    })
  }
}

function spawnSidecar(mode) {
  const child = spawn('node', [SIDECAR, `--mode=${mode}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Client(child)
}

// --- test runner ---

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function run() {
  console.log('=== chat-mode sidecar ===')
  const c = spawnSidecar('chat')

  // 1. initialize
  try {
    const r = await c.request('initialize', { clientVersion: '0.0.1' })
    record('initialize', !!r.sidecarVersion, `v${r.sidecarVersion} on ${r.node}`)
  } catch (e) {
    record('initialize', false, e.message)
    return
  }

  // 2. setToken
  try {
    await c.request('setToken', { token: TOKEN })
    record('setToken', true)
  } catch (e) {
    record('setToken', false, e.message)
    return
  }

  // 3. simple chat — collect events until done
  const runId = 'run-1'
  let chatOk = false
  let chatText = ''
  c.onEvent((msg) => {
    if (msg.method === 'chat/event' && msg.params.runId === runId) {
      const ev = msg.params.event
      if (ev?.type === 'assistant') {
        const blocks = ev.message?.content ?? []
        for (const b of blocks) {
          if (b.type === 'text') chatText += b.text
        }
      }
    }
  })
  try {
    const ack = await c.request('chat', {
      runId,
      model: 'claude-sonnet-4-6',
      prompt: 'Reply with exactly one word: hello',
    })
    if (!ack.accepted) throw new Error('not accepted')
    await c.waitForNotification('chat/done', (p) => p.runId === runId)
    chatOk = chatText.toLowerCase().includes('hello')
    record('chat (single)', chatOk, `text="${chatText.trim()}"`)
  } catch (e) {
    record('chat (single)', false, e.message)
  }

  // 4. multiplexed: two chats concurrently
  const runA = 'run-A'
  const runB = 'run-B'
  let textA = ''
  let textB = ''
  c.onEvent((msg) => {
    if (msg.method !== 'chat/event') return
    const { runId: r, event } = msg.params
    if (event?.type === 'assistant') {
      const blocks = event.message?.content ?? []
      for (const b of blocks) {
        if (b.type === 'text') {
          if (r === runA) textA += b.text
          if (r === runB) textB += b.text
        }
      }
    }
  })
  try {
    const [ackA, ackB] = await Promise.all([
      c.request('chat', { runId: runA, model: 'claude-sonnet-4-6', prompt: 'Reply only: A' }),
      c.request('chat', { runId: runB, model: 'claude-sonnet-4-6', prompt: 'Reply only: B' }),
    ])
    if (!ackA.accepted || !ackB.accepted) throw new Error('not accepted')
    await Promise.all([
      c.waitForNotification('chat/done', (p) => p.runId === runA),
      c.waitForNotification('chat/done', (p) => p.runId === runB),
    ])
    record('chat (multiplex 2)', true, `A="${textA.trim()}" B="${textB.trim()}"`)
  } catch (e) {
    record('chat (multiplex 2)', false, e.message)
  }

  // 5. cancel mid-flight
  const runC = 'run-C'
  try {
    const ack = await c.request('chat', {
      runId: runC,
      model: 'claude-sonnet-4-6',
      prompt: 'Count slowly from 1 to 30, one number per line.',
    })
    if (!ack.accepted) throw new Error('not accepted')
    // Give it a beat to start streaming, then cancel.
    await new Promise((r) => setTimeout(r, 300))
    c.notify('chat/cancel', { runId: runC })
    const err = await c.waitForNotification('chat/error', (p) => p.runId === runC)
    record('chat cancel', err.code === 'CANCELLED', `code=${err.code}`)
  } catch (e) {
    record('chat cancel', false, e.message)
  }

  // 6. shutdown
  try {
    await c.request('shutdown', null)
    // Wait for process exit
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (c.exitCode != null) {
          clearInterval(t)
          resolve()
        }
      }, 50)
      setTimeout(() => {
        clearInterval(t)
        resolve()
      }, 2000)
    })
    record('shutdown', c.exitCode === 0, `exit=${c.exitCode}`)
  } catch (e) {
    record('shutdown', false, e.message)
  }

  console.log('\n=== title-mode sidecar (single-flight) ===')
  const t = spawnSidecar('title')
  try {
    await t.request('initialize', { clientVersion: '0.0.1' })
    await t.request('setToken', { token: TOKEN })
    const a = t.request('chat', { runId: 't1', model: 'claude-haiku-4-5', prompt: 'Say: hi' })
    // Try to start a second one before the first finishes — should BUSY.
    let busy = false
    try {
      await t.request('chat', { runId: 't2', model: 'claude-haiku-4-5', prompt: 'Say: hi' })
    } catch (e) {
      busy = e.code === -32001
    }
    record('title BUSY when single-flight', busy)
    await a
    await t.waitForNotification('chat/done', (p) => p.runId === 't1')
    await t.request('shutdown', null)
    record('title shutdown', true)
  } catch (e) {
    record('title flow', false, e.message)
    try {
      t.child.kill()
    } catch {}
  }

  // Summary
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error(e)
  process.exit(2)
})
