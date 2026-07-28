// Headless behavioural check for the compound-loop change #1: after a user
// REJECTS an edit, `buildEditOutcomeNote` folds a nudge into the next turn
// inviting the model to promote a durable correction into
// `_system/preferences.md`. Unit tests cover that the nudge TEXT is produced;
// this harness covers the part unit tests can't — does the MODEL actually act
// on it and call propose_edit / propose_write targeting `_system/preferences.md`?
//
// It drives a live sidecar exactly like the app does: real default persona +
// CLAUDE.md as the systemPrompt, the propose_* relay tools, a scratch vault,
// and a user turn = the reject HOST NOTE (mirrors buildEditOutcomeNote's
// output) + a correction that implies a durable preference. Then it watches
// the emitted proposals for one that targets `_system/preferences.md`.
//
// Auth: reads the app's own OAuth token from params (CLAUDE_CODE_OAUTH_TOKEN).
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-reject-preference.mjs

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

if (!TOKEN) {
  console.log('No CLAUDE_CODE_OAUTH_TOKEN set — cannot run the live model check.')
  process.exit(2)
}

// ── Scratch vault ────────────────────────────────────────────────────────
// A real reject targets a wiki note; preferences.md pre-exists with a bullet
// so the model can anchor an append (propose_edit) rather than being forced to
// propose_write — but we accept either.
const vault = mkdtempSync(join(tmpdir(), 'reject-pref-vault-'))
mkdirSync(join(vault, '_system'), { recursive: true })
mkdirSync(join(vault, 'wiki'), { recursive: true })
writeFileSync(
  join(vault, '_system', 'preferences.md'),
  '# Preferences\n\n- Reply in the language the user writes in.\n',
)
writeFileSync(
  join(vault, 'wiki', 'meeting-notes.md'),
  '# Meeting notes\n\n## Summary\n\nThe team decided to postpone the launch.\n',
)

// ── System prompt: the real persona + CLAUDE.md, as the host assembles it ──
const persona = readFileSync(join(APP_SRC, 'agents', 'default.md'), 'utf8')
const claudeMd = readFileSync(join(APP_SRC, 'CLAUDE.md'), 'utf8')
const systemPrompt = [
  persona,
  '--- CLAUDE.md ---',
  claudeMd,
  '--- WORKSPACE ---',
  `Vault root (absolute): ${vault}`,
  `Preferences file (absolute): ${join(vault, '_system', 'preferences.md')}`,
].join('\n\n')

// ── User turn: the reject HOST NOTE (mirrors buildEditOutcomeNote) + a
//    correction that implies a DURABLE preference (casual, not formal). ─────
//
// The nudge is UNCONDITIONAL here; production gates it on `anyRejected`
// (buildEditOutcomeNote.ts: `...(anyRejected ? ['', ...PREFERENCE_NUDGE_LINES] : [])`).
// Sound, because every scenario in this file is a rejection — but the copy hides
// that the gate exists at all, so a change to WHEN production emits the nudge
// would leave this passing against a shape production no longer produces.
// harnessProseParity.test.ts pins the wording; nothing pins the condition.
// The reject REASON is itself part of the signal. A style reject (durable case)
// implies a reusable rule; a factual reject (oneoff case) does not — so the
// oneoff case must vary BOTH the reject reason and the follow-up message,
// otherwise the model rightly generalises the style reject.
const CASE = process.env.CASE === 'oneoff' ? 'oneoff' : 'durable'
const rejectLine =
  CASE === 'oneoff'
    ? '- `Meeting notes` ("added a launch date to the summary"): rejected by the user — your change is NOT in the file.'
    : '- `Meeting notes` ("rewrote the summary in a formal tone"): rejected by the user — your change is NOT in the file.'

const hostNote = [
  '[HOST NOTE — outcomes of edits you proposed earlier in this conversation.',
  'This is a system message, NOT something the user typed.]',
  'Some edits you proposed did not end up in the files:',
  rejectLine,
  'Do not assume these edits were saved. Re-read the relevant file before',
  'proposing any follow-up edit that depends on them.',
  '',
  'A rejection can be an implicit signal about how the user wants you to work,',
  'not just a verdict on this one edit. If this rejection — taken together with',
  "the user's current message — reveals a DURABLE rule about how you should act",
  'or shape output (tone, format, language, a default to always apply), propose',
  'appending ONE concise bullet to `_system/preferences.md` via propose_edit',
  '(create the file if it does not exist yet). Only for a genuinely reusable',
  'rule — never for a one-off, and never invent a rule the user did not imply.',
  'If unsure, do nothing.',
].join('\n')

// durable → EXPECT a preferences.md proposal. oneoff → EXPECT none (no spam).
const userMessage =
  CASE === 'oneoff'
    ? "그 날짜는 내가 착각했네. 그냥 'postpone'을 'delay'로만 바꿔줘."
    : '아니 이거 너무 딱딱하잖아. 나는 원래 이런 회의 요약은 격식체 말고 편한 말투로 쓰는 걸 좋아해.'

const prompt = `${hostNote}\n\n${userMessage}`

// ── JSON-RPC plumbing (mirrors verify-profile-title.mjs) ──────────────────
const child = spawn('node', [SIDECAR, '--mode=chat'], {
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

let failed = false
const ok = (l) => console.log(`  ✓ ${l}`)
const bad = (l, e) => {
  failed = true
  console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`)
}

// Watch every proposal notification; capture ones targeting preferences.md.
const prefProposals = []
const allProposals = []
notifListeners.push((msg) => {
  const m = msg.method
  if (m === 'chat/edit-pending' || m === 'chat/write-pending' || m === 'chat/skill-pending') {
    const fp = msg.params?.input?.file_path ?? msg.params?.name ?? '(skill)'
    allProposals.push({ method: m, fp })
    // Match the TARGET, not the whole payload. This used to test
    // `JSON.stringify(msg.params).includes('preferences.md')`, which also fires
    // on a proposal against some OTHER file whose new_string merely mentions
    // the name — inflating the durable case into a false pass and the one-off
    // case into a false failure.
    if (String(fp).includes('preferences.md')) prefProposals.push({ method: m, params: msg.params })
  }
})

function runChat(runId) {
  return new Promise((resolve) => {
    const off = (msg) => {
      if (msg.params?.runId && msg.params.runId !== runId) return
      if (msg.method === 'chat/done') resolve({ kind: 'ok' })
      else if (msg.method === 'chat/error') resolve({ kind: 'error', code: msg.params.code })
    }
    notifListeners.push(off)
    request('chat', {
      runId,
      model: 'claude-sonnet-5',
      systemPrompt,
      prompt,
      vaultPath: vault,
      relayTools: ['propose_edit', 'propose_write', 'propose_skill', 'move_note'],
      builtinTools: ['Read', 'Glob', 'Grep'],
      allowDelegation: false,
      sandboxEnabled: false,
    }).catch((err) => resolve({ kind: 'error', code: err?.code, message: err?.message }))
  })
}

try {
  const init = await request('initialize', {})
  init?.mode === 'chat' ? ok(`initialize (node ${init.node})`) : bad('initialize', JSON.stringify(init))

  const st = await request('setToken', { token: TOKEN })
  st === null ? ok('setToken') : bad('setToken', JSON.stringify(st))

  console.log('  … running chat turn (reject note + correction), waiting for proposals')
  // The runId doubles as the SDK session id, and the CLI rejects anything that
  // isn't a UUID — "Error: Invalid session ID. Must be a valid UUID." A readable
  // literal here kills the turn before the model runs, surfacing only as an opaque
  // INTERNAL. verify-stale-retry hit this and fixed itself; the note never spread.
  const r = await runChat(globalThis.crypto.randomUUID())
  if (r.kind !== 'ok') bad('chat run did not complete', JSON.stringify(r))

  console.log(`\n  case=${CASE}  proposals seen: ${JSON.stringify(allProposals)}`)
  if (CASE === 'durable') {
    if (prefProposals.length > 0) {
      ok(`durable correction → model proposed a preferences.md edit (${prefProposals.length})`)
      for (const p of prefProposals) {
        const inp = p.params.input
        if (inp?.new_string) console.log(`    + new_string: ${JSON.stringify(inp.new_string)}`)
        if (inp?.content) console.log(`    + content: ${JSON.stringify(inp.content).slice(0, 300)}`)
      }
    } else {
      bad('durable correction produced NO preferences.md proposal', `${allProposals.length} other`)
    }
  } else {
    // POSITIVE CONTROL. The verdict below is "no preferences.md proposal", which
    // is equally true of a model that proposed nothing at all — declined, errored,
    // or never had the relay tools registered. The one-off prompt asks for a real
    // edit to the meeting note, so at least one proposal MUST have arrived for
    // the restraint to mean anything.
    allProposals.length > 0
      ? ok(`the model did propose something (${allProposals.length}) — restraint is measurable`)
      : bad('NO proposal at all — "no preferences.md edit" proves nothing here')
    // oneoff: a preferences.md proposal here would be spam.
    prefProposals.length === 0
      ? ok('one-off correction → NO preferences.md proposal (no spam)')
      : bad('one-off correction wrongly produced a preferences.md proposal', JSON.stringify(prefProposals.map((p) => p.params.input?.new_string)))
  }

  await request('shutdown', {}).catch(() => {})
} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  setTimeout(() => {
    child.kill('SIGTERM')
    console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
    process.exit(failed ? 1 : 0)
  }, 300)
}
