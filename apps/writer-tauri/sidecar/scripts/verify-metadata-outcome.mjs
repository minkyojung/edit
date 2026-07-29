// The metadata relay tools told the model they worked before anyone had looked
// at the note.
//
// `set_note_status` emitted a notification and immediately returned
// "Status set: X → done". The host declines silently for a note it cannot find
// and for doc types that carry no status — its own tool description says so —
// so the user heard "완료 처리했습니다" for a write that never happened, and the
// model had no way to know.
//
// Drives the tool handlers directly with a stub host, so no token and no model.
// A refusal has to reach the model as text it can act on, and the two refusals
// have to say different things: a doc type that cannot carry a status is a
// dead end, a missing note means fix the path and retry.
//
//   node scripts/verify-metadata-outcome.mjs

// The product's own builders, not a restatement of them — the refusal text is
// the thing under test, so a copy here would drift and stay green.
import { buildSetNoteStatusTool, buildSetNoteTagsTool } from '../src/server.mjs'

let failed = false
const check = (label, cond, detail = '') => {
  if (!cond) failed = true
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** The two tools, wired to a host that answers however the test says. */
const toolsWith = (answer) => ({
  set_note_status: buildSetNoteStatusTool(answer),
  set_note_tags: buildSetNoteTagsTool(answer),
})

const text = async (tool, input) => (await tool.handler(input)).content[0].text

console.log('── the host said yes ──')
{
  const t = toolsWith(async () => ({ ok: true }))
  const s = await text(t.set_note_status, { path: 'wiki/A.md', status: 'done' })
  check('a successful status write still reads as success', /Status set/.test(s), s)
  const g = await text(t.set_note_tags, { path: 'wiki/A.md', tags: ['x'] })
  check('a successful tag write still reads as success', /Tags set/.test(g), g)
}

console.log('\n── the host declined: the note cannot carry a status ──')
{
  const t = toolsWith(async () => ({ ok: false, reason: 'unsupported-doc-type' }))
  const s = await text(t.set_note_status, { path: 'daily/2026-07-29.md', status: 'done' })
  check('the model is told it did NOT happen', /error/i.test(s) && !/^Status set/.test(s), s)
  check('the refusal names the path', s.includes('daily/2026-07-29.md'))
  // A dead end. Retrying is the failure mode this text exists to prevent.
  check('the model is told not to retry', /do not retry/i.test(s))
}

console.log('\n── the host declined: there is no such note ──')
{
  const t = toolsWith(async () => ({ ok: false, reason: 'no-such-note' }))
  const s = await text(t.set_note_status, { path: 'wiki/Ghost.md', status: 'done' })
  check('the model is told it did NOT happen', /error/i.test(s) && !/^Status set/.test(s), s)
  // Recoverable, and differently from the case above — the point of keeping
  // two reasons rather than one boolean.
  check('this one DOES tell the model to look and retry', /call this again|find the real one/i.test(s))
  check('and is distinguishable from the dead end', !/do not retry/i.test(s))
}

console.log('\n── the host never answered ──')
{
  const t = toolsWith(async () => {
    throw new Error('the run was cancelled')
  })
  const s = await text(t.set_note_status, { path: 'wiki/A.md', status: 'done' })
  check('a released request reaches the model as a failure', /error/i.test(s), s)
  check('carrying the reason', s.includes('the run was cancelled'))
}

console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
process.exit(failed ? 1 : 0)
