// Headless end-to-end check for the whole-doc STALE → model-retry loop.
// Drives a live sidecar; this harness plays the HOST. It lets the model make a
// whole-doc `propose_write`, then acks that first proposal as STALE
// (`chat/edit-ack` ok:false + a reason that inlines the "latest" body, as the
// real CAS would when the user edited the note mid-generation). It verifies the
// real model then RETRIES propose_write and REBASES onto the injected latest
// (i.e. keeps the user's line instead of resubmitting its stale version).
//
// This validates the Layer A/C mechanism — the edit-ack `reason` channel
// carrying the host's refusal back to the model so it retries. The delivery is
// the propose_write ROUND-TRIP: the tool handler awaits the verdict and returns
// it as its own result. (It rode a PostToolUse hook when this file was written;
// see HISTORY below for why that path was replaced.)
//
//   CLAUDE_CODE_CLI_PATH=/path/to/claude \
//   CLAUDE_CONFIG_DIR=$(mktemp -d) \        # avoid unrelated user hooks
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... \
//   node scripts/verify-stale-retry.mjs
//
// HISTORY (2026-07-21): this harness first ran against the PostToolUse-hook
// delivery path and uncovered two real production bugs — the ack-hook matcher
// never matched the namespaced MCP tool names (`mcp__writer-relay__propose_*`),
// and `#handleEditAck` deleted the ack slot before the hook read it. Even with
// both fixed, hook-rewrite delivery was flaky (~2/3): the rewrite races the
// model's consumption of the tool result. So `propose_write` was converted to a
// ROUND-TRIP tool (its handler awaits the host verdict and returns the stale
// error DIRECTLY as the tool result). That path is deterministic — this harness
// now passes 3/3: the model always sees the stale body and rebases.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FrameParser, encode } from '../src/jsonrpc.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(__dirname, '..', 'src', 'index.mjs')
const APP_SRC = join(__dirname, '..', '..', 'src', 'agent', 'defaults')
const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!TOKEN) { console.log('No CLAUDE_CODE_OAUTH_TOKEN set.'); process.exit(2) }

const USER_LINE = '- third item ADDED BY USER'
// The body the user has "in the editor" — what the CAS would report as latest.
const LATEST_BODY = `# Notes\n- first item\n- second item\n${USER_LINE}\n`

const vault = mkdtempSync(join(tmpdir(), 'stale-vault-'))
mkdirSync(join(vault, 'wiki'), { recursive: true })
const notePath = join(vault, 'wiki', 'Notes.md')
// The model reads THIS first (2 items — no user line yet).
writeFileSync(notePath, '# Notes\n- first item\n- second item\n')

const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')
const systemPrompt = [persona, '--- CLAUDE.md ---', claudeMd, '--- WORKSPACE ---', `Vault root (absolute): ${vault}`].join('\n\n')

const child = spawn('node', [SIDECAR, '--mode=chat'], { stdio: ['pipe', 'pipe', 'inherit'] })
const parser = new FrameParser()
let nextId = 1
const pending = new Map()
const notifListeners = []
child.stdout.on('data', (chunk) => {
  parser.push(chunk)
  for (let msg = parser.shift(); msg; msg = parser.shift()) {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? reject(msg.error) : resolve(msg.result)
    } else if (msg.method) { for (const l of notifListeners) l(msg) }
  }
})
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(encode({ jsonrpc: '2.0', id, method, params })) })
}
function notify(method, params) { child.stdin.write(encode({ jsonrpc: '2.0', method, params })) }

let failed = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => { failed = true; console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`) }

const writes = [] // { pendingId, content }
let assistantText = ''
let sawStaleErrorToModel = false
notifListeners.push((msg) => {
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'assistant') {
    for (const b of msg.params.event.message?.content ?? []) if (b.type === 'text') assistantText += b.text
  }
  // Did the stale error actually reach the model as a tool_result? Tool results
  // come back as 'user'-type events carrying tool_result blocks.
  if (msg.method === 'chat/event' && msg.params?.event?.type === 'user') {
    const blocks = msg.params.event.message?.content ?? []
    for (const b of blocks) {
      const text = typeof b?.content === 'string' ? b.content
        : Array.isArray(b?.content) ? b.content.map((c) => c?.text ?? '').join(' ') : ''
      if (/changed since you read it|could not be queued|ADDED BY USER/i.test(text)) {
        sawStaleErrorToModel = true
        console.log(`  … model received stale/error tool_result (${text.length} chars)`)
      }
    }
  }
  // HOST role: react to each whole-doc write proposal.
  if (msg.method === 'chat/edit-pending') {
    const { pendingId, input } = msg.params
    const content = input?.content ?? ''
    writes.push({ pendingId, content })
    const n = writes.length
    if (n === 1) {
      // First write: refuse as STALE. Simulate the user's edit landing on disk
      // (the flush catches up) AND inline the latest in the reason, so the
      // model can rebase whether it re-reads or trusts the message.
      writeFileSync(notePath, LATEST_BODY)
      const reason =
        `wiki/Notes.md changed since you read it — line 4 differs from the ` +
        `version you wrote against. Do NOT resubmit your previous version; it ` +
        `would discard the user's edits. Rewrite against the current content ` +
        `below and call the write tool again:\n\n${LATEST_BODY}`
      console.log(`  … write #1 received (${content.length} chars) — acking STALE`)
      notify('chat/edit-ack', { pendingId, ok: false, reason })
    } else {
      console.log(`  … write #${n} received (${content.length} chars) — acking OK`)
      notify('chat/edit-ack', { pendingId, ok: true })
    }
  }
})

function runChat(runId, prompt) {
  return new Promise((resolve) => {
    notifListeners.push((msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    })
    request('chat', {
      // sessionId/threadId derive from runId and the SDK requires a valid UUID.
      runId, threadId: runId, model: 'claude-sonnet-5', systemPrompt, prompt, vaultPath: vault,
      relayTools: ['propose_write'],
      builtinTools: ['Read', 'Glob', 'Grep'], allowDelegation: false, sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))
  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  const prompt =
    'Read wiki/Notes.md, then use the Write tool to rewrite the whole file: ' +
    'keep every existing list item, and add a single one-line summary sentence ' +
    'right under the "# Notes" heading. If a write is rejected because the file ' +
    'changed, rebase onto the current content and write again.'
  console.log('  … running chat (expect a whole-doc write, then a stale-driven retry)')
  const r = await runChat(globalThis.crypto.randomUUID(), prompt)
  if (r.kind !== 'ok') bad('chat run did not complete', JSON.stringify(r))

  console.log('\n  --- assistant reply ---\n  ' + assistantText.trim().replace(/\n/g, '\n  ') + '\n')
  sawStaleErrorToModel
    ? ok('stale error was delivered to the model as a tool_result')
    : bad('stale error NEVER reached the model — the round-trip did not return the verdict')

  // Assertions.
  writes.length >= 1 ? ok(`model called propose_write (${writes.length}x)`) : bad('model never called propose_write')
  writes.length >= 2
    ? ok('model RETRIED after the stale ack (the loop fired)')
    : bad('model did NOT retry after stale — the reason→verdict→retry loop failed')

  if (writes.length >= 2) {
    const retry = writes[writes.length - 1].content
    retry.includes('ADDED BY USER')
      ? ok('retry REBASED onto the latest (kept the user\'s line)')
      : bad('retry did not include the user line — model resubmitted stale content', retry.slice(0, 200))
    const first = writes[0].content
    !first.includes('ADDED BY USER')
      ? ok('sanity: first write did NOT have the user line (as expected)')
      : bad('first write already had the user line — test setup off')
  }

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => { child.kill('SIGTERM'); console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS'); process.exit(failed ? 1 : 0) }, 300)
}
