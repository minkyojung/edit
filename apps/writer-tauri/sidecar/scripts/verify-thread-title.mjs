// Verifies the thread-title POLICY, not just its transport
// (`verify-profile-title` covers the transport: one run, does text arrive).
//
// A chat title is a one-line naming of what the user wants to do. Three things
// have to hold for the tab to end up with one, and none of them were covered:
//
//   1. SHAPE — the answer is a title, not an answer to the message. The title
//      sidecar used to run with the full `claude_code` tool preset and no
//      maxTurns, so the model treated the first message as work to do and
//      replied to it: 12 lines, first line a sentence. The caller takes the
//      first line verbatim (generateThreadTitle.ts:79) so that sentence became
//      the tab title.
//   2. NO TRUNCATION — the caller hard-caps at 30 chars and appends an
//      ellipsis. A title that needs the cap is a title the model got wrong, so
//      the cap must never fire.
//   3. BACK-TO-BACK — starting two new chats in quick succession must title
//      both. `mode === 'title'` used to be single-flight against a thread
//      registry that takes ~4-6s to drain after `chat/done`, so the second new
//      chat inside that window got BUSY and stayed untitled forever (the caller
//      never retries).
//
// This sends NO systemPrompt. That is the check, not an omission: the title
// prompt and the one-shot tool constraints belong to the sidecar's title mode,
// so the harness cannot hand-copy them out of sync with the product. If the
// sidecar stops supplying them, the model free-associates and SHAPE fails.
//
// Assertions are on observable output (line count, length, intent form), never
// on a restatement of the prompt's wording.
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-thread-title.mjs

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN

if (!TOKEN) {
  console.log('CLAUDE_CODE_OAUTH_TOKEN not set — this check drives a live model.')
  process.exit(2)
}

// The caller's post-processing budget. Mirrors TITLE_MAX_CHARS in
// generateThreadTitle.ts: at or under this, the tab shows the model's title
// intact; over it, the caller truncates and appends an ellipsis.
const NO_TRUNCATION_AT = 30
// The caller's own give-up point (TIMEOUT_MS). A title slower than this never
// reaches the tab at all.
const CALLER_TIMEOUT_MS = 25_000

// Same shape the app sends: a first user message, and nothing else.
const CASES = [
  { prompt: '오늘 회의록 정리해줘', lang: 'ko' },
  { prompt: 'refactor the auth module please', lang: 'en' },
  { prompt: '이 노트 영어로 번역해줄 수 있어?', lang: 'ko' },
]

const child = spawn('node', [SIDECAR, '--mode=title'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifListeners = []

child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) {
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

// Replays generateThreadTitle.ts's event handling: accumulate assistant text,
// settle on done/error, give up at the caller's timeout. Deliberately does NOT
// replay its cleanup (first-line / quote-strip / cap) — the cap is what we're
// asserting never has to fire, so applying it here would hide the failure.
function titleRun(prompt) {
  const runId = randomUUID()
  let text = ''
  const t0 = Date.now()
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ kind: 'timeout', ms: Date.now() - t0 }),
      CALLER_TIMEOUT_MS,
    )
    notifListeners.push((msg) => {
      if (msg.params?.runId !== runId) return
      if (msg.method === 'chat/event') {
        const ev = msg.params.event
        if (ev?.type === 'assistant') {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && typeof b.text === 'string') text += b.text
          }
        }
      } else if (msg.method === 'chat/done') {
        clearTimeout(timer)
        resolve({ kind: 'done', text: text.trim(), ms: Date.now() - t0 })
      } else if (msg.method === 'chat/error') {
        clearTimeout(timer)
        resolve({ kind: 'chat/error', code: msg.params.code, message: msg.params.message })
      }
    })
    // No systemPrompt, no builtinTools, no maxTurns — the sidecar's title mode
    // owns all three. A refusal arrives as a JSON-RPC error RESPONSE (BUSY,
    // NO_TOKEN), not a chat/error notification.
    request('chat', { runId, model: 'claude-haiku-4-5', prompt }).catch((err) =>
      resolve({ kind: 'refused', code: err?.code, message: err?.message }),
    )
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
  await request('setToken', { token: TOKEN })
  ok('setToken')

  // BACK-TO-BACK: fired without waiting, the way two new chats first-messaged
  // seconds apart reach the sidecar. No sleep — a sleep here is what let the
  // single-flight window go unnoticed.
  console.log('\n  three titles, back to back:')
  const results = await Promise.all(CASES.map((c) => titleRun(c.prompt)))

  results.forEach((r, i) => {
    const { prompt, lang } = CASES[i]
    const label = JSON.stringify(prompt)

    if (r.kind === 'refused') {
      bad(`${label} refused`, `code=${r.code} ${r.message ?? ''}`)
      return
    }
    if (r.kind === 'chat/error') {
      bad(`${label} errored`, `code=${r.code} ${r.message ?? ''}`)
      return
    }
    if (r.kind === 'timeout') {
      bad(`${label} exceeded the caller's ${CALLER_TIMEOUT_MS}ms budget`)
      return
    }

    const lines = r.text.split(/\r?\n/).filter((s) => s.trim().length > 0)
    const title = lines[0] ?? ''
    const detail = `${JSON.stringify(title)} lines=${lines.length} chars=${title.length} ${r.ms}ms`

    if (lines.length !== 1) {
      bad(`${label} → the model answered the message instead of titling it`, detail)
      return
    }
    if (title.length > NO_TRUNCATION_AT) {
      bad(`${label} → too long, the caller would truncate it`, detail)
      return
    }
    // Intent form: names the action the user wants taken. Korean marks that
    // with the `~하기` nominaliser; English with a leading gerund.
    const intentForm = lang === 'ko' ? /하기$/.test(title) : /^[A-Z][a-z]+ing\b/.test(title)
    if (!intentForm) {
      bad(`${label} → not in intent form`, detail)
      return
    }
    ok(`${label} → ${detail}`)
  })
} catch (e) {
  bad('unexpected throw', e?.message ?? String(e))
} finally {
  child.stdin.write(encode({ jsonrpc: '2.0', method: 'shutdown' }))
  await new Promise((r) => setTimeout(r, 900))
  child.kill('SIGKILL')
  console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`)
  process.exit(failed ? 1 : 0)
}
