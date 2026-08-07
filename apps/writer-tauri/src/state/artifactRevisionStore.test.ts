import { beforeEach, describe, expect, it } from 'vitest'
import {
  bumpArtifactRevision,
  useArtifactRevisionStore,
} from './artifactRevisionStore'

const revisions = () => useArtifactRevisionStore.getState().revisions

describe('artifactRevisionStore', () => {
  beforeEach(() => {
    useArtifactRevisionStore.setState({ revisions: {} })
  })

  it('starts every path at 0 without an entry', () => {
    expect(revisions()['writing/a.html']).toBeUndefined()
  })

  it('counts up per path', () => {
    bumpArtifactRevision('writing/a.html')
    bumpArtifactRevision('writing/a.html')
    expect(revisions()['writing/a.html']).toBe(2)
  })

  it('keeps paths independent', () => {
    bumpArtifactRevision('writing/a.html')
    bumpArtifactRevision('writing/b.html')
    bumpArtifactRevision('writing/b.html')
    expect(revisions()['writing/a.html']).toBe(1)
    expect(revisions()['writing/b.html']).toBe(2)
  })

  // The failure this store can actually have: mutating the record in place. The
  // counter would still read correctly from getState(), every assertion above
  // would pass, and no subscriber would ever re-render — the feature would look
  // wired and do nothing. Reference inequality is the observable proxy for that.
  it('replaces the record so subscribers see a new reference', () => {
    const before = revisions()
    bumpArtifactRevision('writing/a.html')
    expect(revisions()).not.toBe(before)
  })
})
