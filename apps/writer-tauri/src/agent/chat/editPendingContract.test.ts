// The joint between the two halves of the edit-pending contract.
//
// The sidecar half is a `.mjs` harness; the host half is `.ts`. Neither can
// import the other — `harnessProseParity.test.ts` explains why that stays true
// (a loader dependency, and the harness would stop exercising the real
// transport). So the harness holds the required-field list as source, and this
// is what stops that copy from rotting: it compares the harness's list against
// the value the product DERIVES from its own zod schema.
//
// The direction that matters is the product changing under a frozen copy.
// Someone adds a field to `editPendingEnvelope`, the harness keeps checking the
// old four, and its green run no longer means what it says. Nothing here is
// hand-transcribed — that would just be a third copy to rot.

import { describe, expect, it } from 'vitest'
import { EDIT_PENDING_REQUIRED_FIELDS } from './eventSchemas'
// `?raw` rather than node:fs — the app tsconfig has no @types/node, and pulling
// it in for one test would be a project-wide dependency change. `vite/client` is
// already in `types` and declares this module. Same call `harnessProseParity`
// makes, for the same reason.
import contractSrc from '../../../sidecar/scripts/verify-edit-pending-contract.mjs?raw'
import serverSrc from '../../../sidecar/src/server.mjs?raw'

/** The literal the harness checks payloads against. Parsed out rather than
 * pattern-matched loosely, so a rename of the constant fails here instead of
 * silently matching nothing and passing. */
function harnessRequiredFields(src: string): string[] {
  const m = src.match(/const REQUIRED_FIELDS = \[([^\]]*)\]/)
  if (!m) throw new Error('REQUIRED_FIELDS not found in verify-edit-pending-contract.mjs')
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0)
}

describe('verify-edit-pending-contract.mjs mirrors eventSchemas.ts', () => {
  it('checks exactly the fields the host requires — no more, no fewer', () => {
    expect(harnessRequiredFields(contractSrc)).toEqual([...EDIT_PENDING_REQUIRED_FIELDS])
  })

  it('the product list is non-empty and sorted, so the comparison is stable', () => {
    expect(EDIT_PENDING_REQUIRED_FIELDS.length).toBeGreaterThan(0)
    expect([...EDIT_PENDING_REQUIRED_FIELDS]).toEqual([...EDIT_PENDING_REQUIRED_FIELDS].sort())
  })

  // The harness restates one thing besides the field list: how the payload is
  // composed. The tools send `{ pendingId, toolName, input }` and #askVerdict
  // adds the runId, so the harness reproduces that join. Asserting only that
  // the harness SAYS so would check a comment against itself — the useful
  // question is whether server.mjs still does it, so both sides are read.
  it('reproduces the join server.mjs actually performs', () => {
    expect(serverSrc).toMatch(/#askVerdict\(runId, proposal\)\s*\{[\s\S]*?\{ runId, \.\.\.proposal \}/)
    expect(contractSrc).toContain('{ runId, ...proposal }')
  })
})
