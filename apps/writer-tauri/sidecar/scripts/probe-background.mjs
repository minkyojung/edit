// Stage 4 prerequisite probe: drive a REAL background task and record the exact
// event lifecycle our #runThreadLoop will see — especially whether a completed
// background task produces an AUTONOMOUS follow-up assistant turn (no human
// input), and what currentRunId state accompanies it.
//
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   node scripts/probe-background.mjs
//
// Registers a `background: true` agent that sleeps ~15s, asks the main model to
// delegate to it and return immediately, then keeps the query input open to
// watch for: task_started → task_updated{is_backgrounded} → result
// {background_requested} → task_notification → autonomous assistant turn + 2nd result.

import { query } from '@anthropic-ai/claude-agent-sdk'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token || !token.startsWith('sk-ant-oat')) {
  console.error('Set CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... first.')
  process.exit(2)
}

let releaseInput
const inputClosed = new Promise((r) => (releaseInput = r))
async function* input() {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content:
        'Delegate to the "slowcounter" subagent via the Task tool to do its slow count, then immediately tell me (one sentence) that it is running in the background. Do NOT wait for it to finish.',
    },
    parent_tool_use_id: null,
  }
  await inputClosed
}

const options = {
  env: {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
  },
  settingSources: [],
  permissionMode: 'bypassPermissions',
  includePartialMessages: false,
  forwardSubagentText: true,
  agentProgressSummaries: true,
  tools: ['Task', 'Bash'],
  agents: {
    slowcounter: {
      description: 'Runs a slow background count. Use when asked to count slowly in the background.',
      tools: ['Bash'],
      background: true,
      prompt:
        'You are a slow counter. Run exactly one Bash command: `for i in $(seq 1 15); do echo "count $i"; sleep 1; done` and then report "counted to 15". Nothing else.',
    },
  },
}
if (process.env.CLAUDE_CODE_CLI_PATH) {
  options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_CLI_PATH
}

const t0 = Date.now()
const ts = () => `${String(Date.now() - t0).padStart(6)}ms`
let resultCount = 0
let sawTaskNotification = false
let sawBackgroundRequested = false
let sawIsBackgrounded = false
let autonomousTurnAssistant = 0 // assistant messages seen AFTER result #1

const stream = query({ prompt: input(), options })

// Safety: force-close after 60s so a stuck run can't hang.
const hardStop = setTimeout(() => {
  console.log(`${ts()} [hard stop 60s] releasing input`)
  releaseInput()
}, 60_000)

try {
  for await (const m of stream) {
    const tag = `${m.type}${m.subtype ? '/' + m.subtype : ''}`
    if (m.type === 'system' && String(m.subtype).startsWith('task')) {
      // Dump the full task_* message — this is what we're here to learn.
      console.log(`${ts()} ${tag}`, JSON.stringify({
        task_id: m.task_id,
        tool_use_id: m.tool_use_id,
        status: m.status,
        subagent_type: m.subagent_type,
        description: m.description,
        summary: m.summary,
        output_file: m.output_file,
        patch: m.patch,
      }))
      if (m.subtype === 'task_notification') sawTaskNotification = true
      if (m.subtype === 'task_updated' && m.patch?.is_backgrounded) sawIsBackgrounded = true
    } else if (m.type === 'result') {
      resultCount++
      const tr = m.terminal_reason ?? '(none)'
      if (tr === 'background_requested') sawBackgroundRequested = true
      console.log(`${ts()} === RESULT #${resultCount} terminal_reason=${tr} is_error=${m.is_error} ===`)
      console.log(`         result: ${JSON.stringify(m.result)?.slice(0, 140)}`)
      // After the FIRST result, keep the input open a while to catch the
      // autonomous completion turn; close once we've seen the notification + a
      // following result, or let the 60s hardStop end it.
      if (resultCount >= 2 && sawTaskNotification) {
        console.log(`${ts()} got autonomous 2nd result after task_notification — closing`)
        releaseInput()
      }
    } else if (m.type === 'assistant') {
      const origin = m.origin ? JSON.stringify(m.origin) : ''
      const isSub = m.parent_tool_use_id ? ' (subagent)' : ''
      if (resultCount >= 1 && !m.parent_tool_use_id) autonomousTurnAssistant++
      const text = Array.isArray(m.message?.content)
        ? m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 80)
        : ''
      console.log(`${ts()} assistant${isSub}${origin ? ' origin=' + origin : ''} ${text}`)
    } else if (m.type === 'user') {
      const origin = m.origin ? JSON.stringify(m.origin) : ''
      const synth = m.isSynthetic ? ' isSynthetic' : ''
      console.log(`${ts()} user${synth}${origin ? ' origin=' + origin : ''}`)
    } else {
      console.log(`${ts()} ${tag}`)
    }
  }
} catch (err) {
  console.error(`${ts()} STREAM ERROR:`, err?.message ?? err)
} finally {
  clearTimeout(hardStop)
}

console.log('\n================ SUMMARY ================')
console.log(`results: ${resultCount}`)
console.log(`saw task_updated{is_backgrounded}: ${sawIsBackgrounded}`)
console.log(`saw result terminal_reason=background_requested: ${sawBackgroundRequested}`)
console.log(`saw task_notification: ${sawTaskNotification}`)
console.log(`assistant turns AFTER first result (autonomous): ${autonomousTurnAssistant}`)
console.log(
  sawTaskNotification && autonomousTurnAssistant > 0
    ? '\nP2 CONFIRMED: background completion produced an autonomous assistant turn.'
    : '\nNOTE: autonomous-turn / task_notification not observed as expected — inspect the trace above.',
)
process.exit(0)
