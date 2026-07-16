// Empirical probe for the persistent-query refactor (plan Stage 2 prerequisite).
//
// Confirms the ONE load-bearing SDK assumption: in streaming-input mode, when a
// `result` message lands the query() generator does NOT tear down — it parks
// waiting for the next SDKUserMessage, and yielding another user message starts
// a fresh turn ending in a fresh `result`. Also records which `terminal_reason`
// values keep the generator alive vs. end the stream, and whether a background
// subagent's `task_notification` arrives AFTER a turn's result.
//
// Run from the sidecar dir with a real OAuth token:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/probe-persistent.mjs
// Optional: CLAUDE_CODE_CLI_PATH=/path/to/claude to pin the CLI (dev), and
//   PROBE_BACKGROUND=1 to add a third turn that asks for a background task.
//
// This does NOT touch server.mjs — it's a standalone throwaway used to validate
// the assumption before the real machinery is built on top of it.

import { query } from '@anthropic-ai/claude-agent-sdk'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token || !token.startsWith('sk-ant-oat')) {
  console.error('Set CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... first.')
  process.exit(2)
}

// Producer/consumer queue feeding a single long-lived generator — the exact
// shape the real #threadInput will use. Each turn parks after yielding until
// the driver releases it (so we never interleave two turns into one).
let nextResolve = null
let releaseTurn = null
const queue = []
let closed = false

function pushTurn(text) {
  const item = { text }
  if (nextResolve && queue.length === 0) {
    const r = nextResolve
    nextResolve = null
    r(item)
  } else {
    queue.push(item)
  }
}
function close() {
  closed = true
  if (nextResolve) {
    const r = nextResolve
    nextResolve = null
    r({ close: true })
  }
}

async function* input() {
  while (true) {
    const item = await new Promise((resolve) => {
      if (closed) return resolve({ close: true })
      if (queue.length) return resolve(queue.shift())
      nextResolve = resolve
    })
    if (item.close) return
    yield { type: 'user', message: { role: 'user', content: item.text }, parent_tool_use_id: null }
    // Park until the driver has fully observed this turn's result.
    await new Promise((resolve) => {
      releaseTurn = resolve
    })
  }
}

const options = {
  env: {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
  },
  // Match the sidecar: full isolation, no filesystem settings auto-load.
  settingSources: [],
}
if (process.env.CLAUDE_CODE_CLI_PATH) {
  options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_CLI_PATH
}

const results = []
let turnCount = 0
let generatorEnded = false

// Drive the turns: kick off turn 1 immediately; queue later turns as each
// result lands (proving the generator survived the prior result).
pushTurn('Reply with exactly one word: apple')

const stream = query({ prompt: input(), options })
const started = Date.now()

try {
  for await (const msg of stream) {
    const t = `${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`
    if (msg.type === 'result') {
      turnCount++
      const tr = msg.terminal_reason ?? '(none)'
      results.push({ turn: turnCount, subtype: msg.subtype, terminal_reason: tr })
      console.log(`\n=== RESULT #${turnCount} type=${t} terminal_reason=${tr} is_error=${msg.is_error} ===`)
      console.log(`    result text: ${JSON.stringify(msg.result)?.slice(0, 120)}`)

      // Release the generator so it can accept the next turn.
      const rel = releaseTurn
      releaseTurn = null

      if (turnCount === 1) {
        console.log('--> queuing turn 2 (proves generator survived result #1 if it runs)')
        pushTurn('Reply with exactly one word: banana')
        rel?.()
      } else if (turnCount === 2 && process.env.PROBE_BACKGROUND) {
        console.log('--> queuing turn 3 (background task probe)')
        pushTurn(
          'Start a background subagent (Task) that counts slowly to 20, and immediately tell me you started it in the background. Do not wait for it.',
        )
        rel?.()
      } else {
        console.log('--> closing input (no more turns)')
        rel?.()
        close()
      }
    } else if (msg.type === 'system' && String(msg.subtype).startsWith('task')) {
      console.log(
        `  [${Date.now() - started}ms] TASK EVENT ${t} task_id=${msg.task_id} status=${msg.status ?? ''} summary=${(msg.summary ?? '').slice(0, 60)}`,
      )
    } else {
      // Compact one-line trace of every other message type.
      console.log(`  [${Date.now() - started}ms] ${t}`)
    }
  }
  generatorEnded = true
} catch (err) {
  console.error('\nSTREAM ERROR:', err?.message ?? err)
}

console.log('\n================ SUMMARY ================')
console.log(`generator ended cleanly: ${generatorEnded}`)
console.log(`turns observed on ONE query(): ${turnCount}`)
console.log('results:', JSON.stringify(results, null, 2))
console.log(
  turnCount >= 2
    ? '\nPASS: one query() served multiple turns — persistent-query assumption holds.'
    : '\nFAIL: only one turn landed — the generator did NOT survive result #1. Investigate before Stage 2.',
)
process.exit(0)
