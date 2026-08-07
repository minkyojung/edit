// The sidecar's half of the edit-pending contract: what a propose_* tool
// actually puts on the wire, and what it tells the model about each verdict.
//
// The host half is `src/agent/chat/editPending.characterization.test.ts` and
// `editPendingListener.test.ts`. They meet at the payload shape, which the host
// now validates at runtime (`eventSchemas.ts`) — so a field the sidecar stops
// sending stops being a silently-dropped event and becomes a failure here.
//
// Drives the REAL tool handlers with a stub host. No SDK, no CLI, no model, no
// token — same shape as verify-metadata-outcome.mjs, and for the same reason:
// the thing under test is the product's own builder, so importing it is the
// only way the check can't drift away from what ships.
//
//   node scripts/verify-edit-pending-contract.mjs
//
// ── WHAT IT STILL CANNOT SEE ─────────────────────────────────────────────────
// Read this before trusting a green run.
//   • The Rust hop. `manager.rs` routes host/editPending → `claude:edit-pending`
//     and parks the request under `Key::FromParam("pendingId")`. Nothing here
//     executes that; if the routing table lost this method the run stays green.
//   • The SDK actually calling the tool. The handlers are invoked directly, so
//     tool registration, schema coercion and permission gating are all bypassed.
//   • Timing. Real proposals arrive interleaved with streaming and with each
//     other; every call here is sequential and instant.
//   • The 15s ACK_TIMEOUT_MS fail-open. Exercised only in the "host stays
//     silent" case below, and even there by resolving early — the real deadline
//     would make this script take four minutes.
//   • Whether the host DOES anything with the payload. That is the host half's
//     job, and it is tested there.

import { buildProposeEditTool, buildProposeWriteTool } from '../src/tools/relay.mjs'

let failed = false
const check = (label, cond, detail = '') => {
  if (!cond) failed = true
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// The fields the host requires. Held as source rather than imported because
// this file is .mjs and the schema is .ts; `editPendingContract.test.ts`
// asserts this array still equals the product's EDIT_PENDING_REQUIRED_FIELDS,
// so the copy cannot rot quietly.
const REQUIRED_FIELDS = ['input', 'pendingId', 'runId', 'toolName']

const RUN_ID = 'run-under-test'

/** The tools as the server wires them.
 *
 * `server.mjs` builds each with `(p) => this.#askVerdict(getRunId(), p)`, and
 * `#askVerdict` sends `{ runId, ...proposal }`. That composition is reproduced
 * here — it is the one line this file restates, and the assertion below is
 * about its RESULT, so a change to which fields ride along is caught. */
function toolsWith(answer) {
  const sent = []
  const askVerdict = (proposal) => {
    sent.push({ runId: RUN_ID, ...proposal })
    return answer(proposal)
  }
  return {
    sent,
    propose_edit: buildProposeEditTool(askVerdict),
    propose_write: buildProposeWriteTool(askVerdict),
  }
}

const text = async (tool, input) => (await tool.handler(input)).content[0].text
const staged = async () => ({ ok: true, reason: null, applied: false })

console.log('── the payload a proposal puts on the wire ──')
{
  const t = toolsWith(staged)
  await t.propose_edit.handler({
    file_path: '/vault/inbox/a.md',
    old_string: '전',
    new_string: '후',
  })
  await t.propose_write.handler({ file_path: '/vault/inbox/b.md', content: '새 본문' })

  check('both tools asked the host exactly once each', t.sent.length === 2, `${t.sent.length}`)
  for (const [i, payload] of t.sent.entries()) {
    const present = Object.keys(payload).sort()
    const missing = REQUIRED_FIELDS.filter((f) => !(f in payload))
    check(`payload ${i} carries every required field`, missing.length === 0, missing.join(','))
    check(
      `payload ${i} has no field the host would drop as unknown`,
      present.length === REQUIRED_FIELDS.length,
      present.join(','),
    )
    check(`payload ${i} pendingId is a non-empty string`,
      typeof payload.pendingId === 'string' && payload.pendingId.length > 0)
    check(`payload ${i} input is an object`,
      payload.input !== null && typeof payload.input === 'object')
  }
  check('the two proposals got DIFFERENT pendingIds',
    t.sent[0]?.pendingId !== t.sent[1]?.pendingId)
  check('toolName names the built-in each tool mirrors',
    t.sent[0]?.toolName === 'Edit' && t.sent[1]?.toolName === 'Write',
    `${t.sent[0]?.toolName} / ${t.sent[1]?.toolName}`)
  check('input is forwarded verbatim, not reshaped',
    t.sent[0]?.input?.old_string === '전' && t.sent[1]?.input?.content === '새 본문')
}

console.log('\n── the host staged it ──')
{
  const t = toolsWith(staged)
  const e = await text(t.propose_edit, { file_path: '/v/a.md', old_string: 'x', new_string: 'y' })
  check('the model is told it is queued, and not to re-read', /queued for user review/.test(e), e.slice(0, 60))
  check('and not to propose it again', /[Dd]o not propose/.test(e))
}

console.log('\n── the host applied it immediately (auto-accept) ──')
{
  const t = toolsWith(async () => ({ ok: true, reason: null, applied: true }))
  const w = await text(t.propose_write, { file_path: '/v/b.md', content: 'z' })
  check('the model is told it is already saved', /[Aa]pplied immediately/.test(w), w.slice(0, 60))
  check('and explicitly NOT to tell the user to reject a card',
    /never tell|no review card|There is no review card/i.test(w))
}

console.log('\n── the host refused it (stale / unplaceable) ──')
{
  const t = toolsWith(async () => ({
    ok: false,
    reason: 'the file changed since you read it',
    applied: false,
  }))
  const e = await text(t.propose_edit, { file_path: '/v/a.md', old_string: 'x', new_string: 'y' })
  check('a refusal reaches the model as an error', /error/i.test(e), e.slice(0, 60))
  check('carrying the host’s reason', /changed since you read it/.test(e))
  check('and does NOT claim it was queued', !/^Edit queued/.test(e))

  const w = await text(t.propose_write, { file_path: '/v/b.md', content: 'z' })
  check('a refused write says it was NOT applied', /NOT applied/.test(w), w.slice(0, 60))
  check('and says to rewrite rather than resubmit', /[Dd]o not resubmit/.test(w))
}

console.log('\n── the host errored (a run the host gave up on) ──')
{
  const t = toolsWith(async () => {
    throw new Error('run released')
  })
  const e = await text(t.propose_edit, { file_path: '/v/a.md', old_string: 'x', new_string: 'y' })
  // An ERROR is not silence: awaitVerdict turns it into a refusal rather than
  // smoothing it into the fail-open success that a timeout produces.
  check('an error answer becomes a refusal, not a fail-open success', /error/i.test(e), e.slice(0, 60))
  check('and names what went wrong', /run released/.test(e))
}

console.log('\n── the host stayed silent (fail open) ──')
{
  // The real deadline is 15s; resolving late-but-not-that-late proves the
  // policy without the wait. What this does NOT prove is the timeout value.
  const t = toolsWith(
    () => new Promise((r) => setTimeout(() => r({ ok: true, reason: null, applied: false }), 5)),
  )
  const e = await text(t.propose_edit, { file_path: '/v/a.md', old_string: 'x', new_string: 'y' })
  check('a slow host still yields a usable answer', /queued for user review/.test(e), e.slice(0, 60))
}

console.log(failed ? '\nFAILED' : '\nOK')
process.exit(failed ? 1 : 0)
