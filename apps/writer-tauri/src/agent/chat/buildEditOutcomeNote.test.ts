import { beforeEach, describe, expect, it } from 'vitest'
import { buildEditOutcomeNote } from './buildEditOutcomeNote'
import { usePendingChangesStore, type PendingChange } from '@/state/pendingChangesStore'
import { useDocsStore } from '@/state/docsStore'

/** Build a PendingChange fixture — only the fields buildEditOutcomeNote reads
 * matter; the rest carry harmless defaults. */
function change(over: Partial<PendingChange> & { id: string }): PendingChange {
  return {
    source: 'chat',
    pageSlug: 'wiki:x',
    groupId: 'g1',
    createdAt: 0,
    edits: [],
    context: { threadId: 't1' },
    status: 'pending',
    decidedAt: null,
    viewedAt: null,
    feedbackDeliveredAt: null,
    ...over,
  }
}

function seed(changes: PendingChange[]): void {
  usePendingChangesStore.setState({
    byId: Object.fromEntries(changes.map((c) => [c.id, c])),
  })
}

beforeEach(() => {
  usePendingChangesStore.setState({ byId: {} })
  // knownDocs drives the human page name; leave empty so names fall back to slug.
  useDocsStore.setState({ knownDocs: [] } as never)
})

describe('buildEditOutcomeNote', () => {
  it('returns null when nothing to report', () => {
    seed([change({ id: 'a', status: 'accepted' })]) // accepted + applied = model belief correct
    expect(buildEditOutcomeNote('t1')).toEqual({ note: null, ids: [] })
  })

  it('collects rejected changes for the thread', () => {
    seed([change({ id: 'a', status: 'rejected', pageSlug: 'wiki:tom' })])
    const { note, ids } = buildEditOutcomeNote('t1')
    expect(ids).toEqual(['a'])
    expect(note).toContain('rejected by the user')
    expect(note).toContain('wiki:tom')
    expect(note).toContain('NOT in the file')
  })

  it('collects accepted-but-apply-failed changes', () => {
    seed([change({ id: 'a', status: 'accepted', applyFailed: true })])
    const { note, ids } = buildEditOutcomeNote('t1')
    expect(ids).toEqual(['a'])
    expect(note).toContain('could not be applied')
  })

  it('excludes accepted+applied and still-pending changes', () => {
    seed([
      change({ id: 'ok', status: 'accepted' }),
      change({ id: 'wait', status: 'pending' }),
    ])
    expect(buildEditOutcomeNote('t1')).toEqual({ note: null, ids: [] })
  })

  it('isolates by thread — other threads are never mixed in', () => {
    seed([
      change({ id: 'mine', status: 'rejected', context: { threadId: 't1' } }),
      change({ id: 'theirs', status: 'rejected', context: { threadId: 't2' } }),
    ])
    const { ids } = buildEditOutcomeNote('t1')
    expect(ids).toEqual(['mine'])
  })

  it('skips already-delivered outcomes (no repeat)', () => {
    seed([change({ id: 'a', status: 'rejected', feedbackDeliveredAt: 123 })])
    expect(buildEditOutcomeNote('t1')).toEqual({ note: null, ids: [] })
  })

  it('includes the model reason when present', () => {
    seed([change({ id: 'a', status: 'rejected', reason: 'added 2026 pricing row' })])
    expect(buildEditOutcomeNote('t1').note).toContain('added 2026 pricing row')
  })

  it('invites a durable preference when a reject is present', () => {
    seed([change({ id: 'a', status: 'rejected' })])
    expect(buildEditOutcomeNote('t1').note).toContain('_system/preferences.md')
  })

  it('does NOT invite a preference for an apply-failure alone (no teaching signal)', () => {
    seed([change({ id: 'a', status: 'accepted', applyFailed: true })])
    const { note } = buildEditOutcomeNote('t1')
    expect(note).toContain('could not be applied')
    expect(note).not.toContain('_system/preferences.md')
  })
})

// Exercises the real store actions the applier + index.ts drive (which
// can't be unit-tested directly through Tauri), end to end: a failed
// apply is recorded, surfaced once, then never repeated after delivery.
describe('buildEditOutcomeNote — store round-trip', () => {
  const store = usePendingChangesStore.getState

  it('apply-failure → surfaced once → stamped → not repeated', () => {
    // 1. Proposal lands as pending (as propose_edit does).
    store().push({
      id: 'p1',
      source: 'chat',
      pageSlug: 'wiki:tom',
      groupId: 'g1',
      edits: [{ id: 'e0', kind: 'replace', anchorBefore: '', before: 'old', after: 'new' }],
      context: { threadId: 't1' },
    })
    // 2. User accepts, but the disk write fails on a stale anchor — the
    //    applier flips status via accept() then flags markApplyFailed().
    store().accept('p1')
    store().markApplyFailed('p1')

    // 3. Next turn: the outcome is collected exactly once.
    const first = buildEditOutcomeNote('t1')
    expect(first.ids).toEqual(['p1'])
    expect(first.note).toContain('could not be applied')

    // 4. index.ts stamps it delivered after a successful start.
    store().markFeedbackDelivered(first.ids)

    // 5. A later turn must NOT report the same failure again.
    expect(buildEditOutcomeNote('t1')).toEqual({ note: null, ids: [] })
  })

  it('reject via store action is collected then stamped', () => {
    store().push({
      id: 'p2',
      source: 'chat',
      pageSlug: 'wiki:jane',
      groupId: 'g1',
      edits: [{ id: 'e0', kind: 'add', anchorBefore: '', after: 'hi' }],
      context: { threadId: 't1' },
    })
    store().reject('p2')
    const { ids } = buildEditOutcomeNote('t1')
    expect(ids).toEqual(['p2'])
    store().markFeedbackDelivered(ids)
    expect(buildEditOutcomeNote('t1').ids).toEqual([])
  })
})
