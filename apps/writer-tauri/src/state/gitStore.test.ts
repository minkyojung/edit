import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the git invoke wrappers so we can drive commit success/failure
// without a real vault. flushDirty + notify are pulled in by the store
// module; stub them to no-ops.
const gitCommit = vi.fn<(message: string) => Promise<string | null>>()
vi.mock('@/lib/git', () => ({
  gitCommit: (message: string) => gitCommit(message),
  gitLogSinceRef: vi.fn().mockResolvedValue([]),
  gitAdvanceRef: vi.fn().mockResolvedValue(undefined),
  gitRevert: vi.fn().mockResolvedValue('newhead'),
  gitCurrentHead: vi.fn().mockResolvedValue(null),
  gitShow: vi.fn().mockResolvedValue(null),
  LAST_REVIEWED_REF: 'refs/heads/last-reviewed',
}))
vi.mock('@/lib/docFileSync', () => ({ flushDirty: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notify', () => ({
  notify: { gitCommitFailed: vi.fn(), gitRevertFailed: vi.fn(), gitRevertSucceeded: vi.fn(), gitMarkReviewedFailed: vi.fn() },
}))

import { useGitStore, aiEditSubject, isAiEditCommit } from './gitStore'
import type { CommitInfo } from '@/lib/git'

describe('gitStore commit lifecycle', () => {
  beforeEach(() => {
    gitCommit.mockReset()
    useGitStore.setState({ dirtyPaths: new Set(), status: 'idle', lastError: null })
  })

  it('preserves dirtyPaths when the commit fails so the user can retry', async () => {
    gitCommit.mockRejectedValue(new Error('boom'))
    useGitStore.getState().noteActivity('wiki/A.md')
    useGitStore.getState().noteActivity('wiki/B.md')

    await useGitStore.getState().commitImmediate()

    const s = useGitStore.getState()
    expect(s.status).toBe('error')
    // The changes are still uncommitted on disk — the dirty set must
    // remain so the Sidebar "Save snapshot" button stays actionable.
    expect([...s.dirtyPaths].sort()).toEqual(['wiki/A.md', 'wiki/B.md'])
  })

  it('clears the committed paths on success', async () => {
    gitCommit.mockResolvedValue('sha1')
    useGitStore.getState().noteActivity('wiki/A.md')

    await useGitStore.getState().commitImmediate()

    const s = useGitStore.getState()
    expect(s.status).toBe('idle')
    expect(s.dirtyPaths.size).toBe(0)
  })

  it('keeps paths added during the await (only the committed subset is cleared)', async () => {
    let resolveCommit: (v: string) => void = () => {}
    gitCommit.mockReturnValue(new Promise<string>((r) => { resolveCommit = r }))
    useGitStore.getState().noteActivity('wiki/A.md')

    const pending = useGitStore.getState().commitImmediate()
    // A new edit lands mid-commit.
    useGitStore.getState().noteActivity('wiki/C.md')
    resolveCommit('sha2')
    await pending

    const s = useGitStore.getState()
    expect([...s.dirtyPaths]).toEqual(['wiki/C.md'])
  })
})

describe('aiEditSubject / isAiEditCommit', () => {
  const commit = (subject: string): CommitInfo => ({ sha: 'x', subject, timestamp: 0, files: [] })

  it('builds a `type(ai): names` subject, capped at two with a +N more tail', () => {
    expect(aiEditSubject('edit', ['Tom'])).toBe('edit(ai): Tom')
    expect(aiEditSubject('edit', ['Tom', 'Ideas'])).toBe('edit(ai): Tom, Ideas')
    expect(aiEditSubject('edit', ['Tom', 'Ideas', 'Plan', 'X'])).toBe(
      'edit(ai): Tom, Ideas (+2 more)',
    )
    expect(aiEditSubject('organize')).toBe('organize(ai)')
  })

  it('recognizes (ai)-scoped subjects as assistant commits', () => {
    expect(isAiEditCommit(commit('edit(ai): Tom'))).toBe(true)
    expect(isAiEditCommit(commit('organize(ai): a.md → daily/2026-06-17'))).toBe(true)
    expect(isAiEditCommit(commit('revert(ai): Tom'))).toBe(true)
  })

  it("does NOT match the user's own `edit:` snapshots", () => {
    expect(isAiEditCommit(commit('edit: Tom.md'))).toBe(false)
    expect(isAiEditCommit(commit('edit: 3 files'))).toBe(false)
    // a filename that happens to contain (ai) must not false-positive
    expect(isAiEditCommit(commit('edit: notes(ai).md'))).toBe(false)
  })
})
