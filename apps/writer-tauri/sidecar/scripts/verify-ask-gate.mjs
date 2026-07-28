// Does the AskUserQuestion gate actually stop the turn and carry the answer back?
//
// The PLUMBING, not the model's judgement. verify-ask-when-forked already covers
// "does the model ask when it should"; nothing covered what happens when it does.
// Four steps, and step 2 is the one that matters:
//
//   1. the model calls AskUserQuestion
//   2. the canUseTool gate PARKS the turn and emits chat/permission
//   3. a chat/decision releases it
//   4. the chosen answer actually reaches the model
//
// If step 2 silently fails the model asks a question nobody is shown and answers
// it itself — the failure is invisible, which is why it needs a check.
//
// Both arms are here because the gate looked mode-dependent and isn't. 0.3.220
// warns at runtime that under `bypassPermissions` "canUseTool will not be
// invoked", and the app relies on 'default' for chat — so arm B started life
// asserting the gate stays silent under bypass. Measured, it fires anyway:
// AskUserQuestion goes through canUseTool regardless of permission mode, which
// makes sense, since it is a request for the HOST to render UI rather than a
// permission question the mode could auto-answer.
//
// That correction matters beyond this file. The intake path (agent/intake.ts)
// runs under bypass to process captured web pages with no user watching, and
// "the gate can't fire there" is NOT why that is safe — it would fire, park the
// turn, and wait for an answer nobody is there to give. What actually protects
// it is that intake's builtinTools are ['Read','Glob','Grep'], so the model has
// no AskUserQuestion to call. Adding it to that list would hang the turn.
//
// Usage:
//   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat... node scripts/verify-ask-gate.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from '../src/server.mjs'

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
if (!token || !token.startsWith('sk-ant-oat')) {
  console.error('Set CLAUDE_CODE_OAUTH_TOKEN first.')
  process.exit(2)
}

const vault = mkdtempSync(join(tmpdir(), 'ask-gate-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const ok = (n, d = '') => console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`)
const bad = (n, d = '') => { failed = true; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) }
const punt = (n) => console.log(`  ! ${n}`)

const SYSTEM =
  'You are a writing assistant. When a request is genuinely ambiguous, use the ' +
  'AskUserQuestion tool to ask before proceeding.'
const PROMPT =
  'Write me a short piece. Use AskUserQuestion first to ask whether it should be ' +
  'fiction or non-fiction.'

function makeServer() {
  const ev = { done: [], err: [], perm: [], text: '' }
  const server = new Server({
    mode: 'chat',
    emit: (m) => {
      if (m.method === 'chat/done') ev.done.push(m.params)
      else if (m.method === 'chat/error') ev.err.push(m.params)
      else if (m.method === 'chat/permission') ev.perm.push(m.params)
      else if (m.method === 'chat/event' && m.params?.event?.type === 'assistant') {
        for (const b of m.params.event.message?.content ?? []) {
          if (b.type === 'text') ev.text += b.text
        }
      }
    },
  })
  const send = (method, params, id) => server.handle({ jsonrpc: '2.0', id, method, params })
  send('initialize', {}, 1)
  send('setToken', { token }, 2)
  return { server, send, ev }
}
const waitFor = async (pred, ms = 180000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(200)
  }
  return false
}
/** One ask→answer round-trip on an existing thread. Returns false when the
 * model simply didn't ask (nothing to conclude), true when the full loop ran. */
async function askRound(send, ev, threadId, prompt, label) {
  const runId = randomUUID()
  const permBefore = ev.perm.length
  const doneBefore = ev.done.length
  send('chat', {
    runId, threadId, persistentQuery: true, vaultPath: vault,
    model: 'claude-sonnet-5', permissionMode: 'default',
    builtinTools: ['AskUserQuestion'], relayTools: [], allowDelegation: false,
    sandboxEnabled: false, systemPrompt: SYSTEM, prompt,
  }, 10)
  await waitFor(() => ev.perm.length > permBefore || ev.done.length > doneBefore || ev.err.length > 0)
  if (ev.perm.length === permBefore) {
    punt(`${label}: the model never called AskUserQuestion, so the gate was not exercised`)
    return false
  }
  ok(`${label}: the gate fired`)

  // Parked means NOT finished — the whole point of the mechanism.
  await sleep(3000)
  ev.done.length === doneBefore
    ? ok(`${label}: the turn is parked, no chat/done while waiting`)
    : bad(`${label}: the turn completed without waiting for an answer`)

  const p = ev.perm[ev.perm.length - 1]
  const q = p.input?.questions?.[0]
  const opts = q?.options ?? []
  const chosen = opts[1] ?? opts[0]
  const answer = typeof chosen === 'string' ? chosen : chosen?.label ?? 'non-fiction'
  console.log(`    asked: ${JSON.stringify(q?.question ?? '').slice(0, 74)}`)

  // Payload shape mirrors the real host (QuestionPanel.tsx): nested under
  // `decision`, answers keyed by the question TEXT. Sent flat, the turn resumes
  // and the model reports the question went unanswered — which reads exactly
  // like a product bug and isn't one.
  send('chat/decision', {
    runId, decisionId: p.decisionId, decision: { answers: { [q?.question ?? 'q']: answer } },
  }, 11)
  const finished = await waitFor(() => ev.done.length > doneBefore || ev.err.length > 0)
  finished && ev.done.length > doneBefore
    ? ok(`${label}: the decision released the turn`)
    : bad(`${label}: the turn never completed after the decision`, `err=${ev.err.map((e) => e.code)}`)
  return true
}

const start = (send, ev, permissionMode) => {
  const runId = randomUUID()
  send({
    runId, threadId: randomUUID(), persistentQuery: true, vaultPath: vault,
    model: 'claude-sonnet-5', permissionMode,
    builtinTools: ['AskUserQuestion'], relayTools: [], allowDelegation: false,
    sandboxEnabled: false, systemPrompt: SYSTEM, prompt: PROMPT,
  })
  return runId
}

try {
  // ── A. 'default': the gate fires, parks, and keeps doing so ─────────────
  //
  // TWO rounds on ONE thread, and the second is the one with teeth. If the
  // prompt generator ever finishes, the SDK closes stdin after the first result
  // and every later control request dies quietly — so round 1 passes and round 2
  // silently doesn't gate. A single-round check would stay green through that
  // forever. (verify-lifecycle T10 guards the same property for free; this is
  // the user-visible half.)
  {
    console.log("\n  --- A. 'default': the gate holds the turn, twice ---")
    const { send, ev } = makeServer()
    const threadId = randomUUID()
    const first = await askRound(send, ev, threadId,
      'Write me a short piece. Use AskUserQuestion first to ask whether it should be fiction or non-fiction.',
      'round 1')
    if (first) {
      const unanswered = /(did ?n.?t get answered|no answer|ask again)/i.test(ev.text)
      unanswered
        ? bad('round 1: the model says the question went unanswered')
        : ok('round 1: the model proceeded on the answer it was given')

      await askRound(send, ev, threadId,
        'Now write another short piece. Use AskUserQuestion again to ask whether it should be funny or serious.',
        'round 2')
    }
  }

  // ── B. bypassPermissions — measured, and NOT what the warning implies ────
  {
    console.log("\n  --- B. 'bypassPermissions': AskUserQuestion still gates ---")
    const { send, ev } = makeServer()
    start((p) => send('chat', p, 20), ev, 'bypassPermissions')
    await waitFor(() => ev.done.length > 0 || ev.err.length > 0 || ev.perm.length > 0)
    if (ev.perm.length > 0) {
      ok('the gate still fires under bypassPermissions')
    } else if (ev.done.length > 0) {
      // If this flips, the note below stops being true and the intake path's
      // safety argument has to be re-derived.
      bad('the gate did NOT fire — AskUserQuestion is no longer exempt from bypass')
    } else {
      punt('the model never called AskUserQuestion, so the arm was not exercised')
    }
  }

  // ── C. Plan mode is enforced by permissionMode, not the tool list ────────
  //
  // The app narrows builtinTools for plan mode AND sets permissionMode 'plan'.
  // builtinTools is frozen at thread creation, so a thread that starts in edit
  // mode keeps the full toolset — which looks like plan mode would leak. It
  // doesn't: permissionMode IS applied per turn, and it is what actually
  // refuses. Worth pinning both because the frozen half is the intuitive
  // suspect, and because the refusal runs through the same canUseTool gate the
  // arms above cover.
  {
    console.log('\n  --- C. plan mode after starting in edit mode ---')
    const { send, ev } = makeServer()
    const threadId = randomUUID()
    const target = join(vault, 'plan-target.txt')
    writeFileSync(target, 'ORIGINAL\n')

    const editRun = randomUUID()
    send('chat', {
      runId: editRun, threadId, persistentQuery: true, vaultPath: vault,
      model: 'claude-sonnet-5', permissionMode: 'default',
      builtinTools: undefined, relayTools: [], allowDelegation: false, sandboxEnabled: false,
      prompt: `Use the Write tool to replace the contents of ${target} with the single word EDITED.`,
    }, 30)
    await waitFor(() => ev.done.length > 0 || ev.err.length > 0)
    readFileSync(target, 'utf-8').includes('EDITED')
      ? ok('edit mode wrote the file (control — the model can do this at all)')
      : punt('edit mode did not write the file, so plan mode blocking it proves nothing')

    if (readFileSync(target, 'utf-8').includes('EDITED')) {
      writeFileSync(target, 'ORIGINAL\n')
      const planRun = randomUUID()
      send('chat', {
        runId: planRun, threadId, persistentQuery: true, vaultPath: vault,
        model: 'claude-sonnet-5', permissionMode: 'plan',
        builtinTools: ['Read', 'Glob', 'Grep', 'Write', 'AskUserQuestion', 'ExitPlanMode'],
        relayTools: [], allowDelegation: false, sandboxEnabled: false,
        prompt: `Use the Write tool to replace the contents of ${target} with the single word EDITED.`,
      }, 31)
      await waitFor(() => ev.done.length > 1 || ev.err.length > 0 || ev.perm.length > 0, 180000)
      await sleep(2000)
      readFileSync(target, 'utf-8').includes('EDITED')
        ? bad('plan mode wrote the file — the mode did not hold')
        : ok('plan mode refused the write on a thread that began in edit mode')
    }
  }

} catch (err) {
  bad('harness threw', err?.message ?? String(err))
} finally {
  rmSync(vault, { recursive: true, force: true })
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exit(failed ? 1 : 0)
}
