import { describe, it, expect, beforeEach } from 'vitest'
import {
  useSaveFailureStore,
  PERSISTENT_THRESHOLD,
  type SaveFailureCause,
} from './saveFailureStore'

const reset = () => useSaveFailureStore.setState({ failures: {} })
const store = () => useSaveFailureStore.getState()

const failN = (slug: string, cause: SaveFailureCause, n: number) => {
  for (let i = 0; i < n; i++) store().recordFailure(slug, cause)
}

describe('saveFailureStore', () => {
  beforeEach(reset)

  it('a momentary blip (below threshold) is not persistent', () => {
    failN('a', 'unreachable', PERSISTENT_THRESHOLD - 1)
    expect(store().hasPersistentFailure()).toBe(false)
    expect(store().worstCause()).toBeNull()
  })

  it('reaching the threshold marks the slug persistent', () => {
    failN('a', 'unreachable', PERSISTENT_THRESHOLD)
    expect(store().hasPersistentFailure()).toBe(true)
    expect(store().worstCause()).toBe('unreachable')
  })

  // #4 regression: a slug that leaves the dirty set (saved, deleted,
  // archived) must not strand a stale persistent entry.
  it('reconcile prunes slugs no longer in the dirty set, clearing the condition', () => {
    failN('a', 'permission', PERSISTENT_THRESHOLD)
    expect(store().hasPersistentFailure()).toBe(true)
    // 'a' is no longer dirty (e.g. it was deleted) → pruned.
    store().reconcile([])
    expect(store().failures).toEqual({})
    expect(store().hasPersistentFailure()).toBe(false)
    expect(store().worstCause()).toBeNull()
  })

  it('reconcile keeps slugs that are still dirty', () => {
    failN('a', 'permission', PERSISTENT_THRESHOLD)
    failN('b', 'disk-full', 1)
    store().reconcile(['a'])
    expect(Object.keys(store().failures)).toEqual(['a'])
  })

  it('reconcile is a no-op (same object) when nothing is stale', () => {
    failN('a', 'permission', 1)
    const before = store().failures
    store().reconcile(['a'])
    expect(store().failures).toBe(before)
  })

  // #8 / #6 regression: the collapsed toast shows the most actionable cause.
  it('worstCause prioritises permission > disk-full > unreachable > unknown', () => {
    failN('a', 'unreachable', PERSISTENT_THRESHOLD)
    failN('b', 'disk-full', PERSISTENT_THRESHOLD)
    failN('c', 'permission', PERSISTENT_THRESHOLD)
    expect(store().worstCause()).toBe('permission')
  })

  it('worstCause ignores non-persistent slugs', () => {
    failN('a', 'unreachable', PERSISTENT_THRESHOLD) // persistent
    failN('b', 'permission', 1) // blip, not persistent
    expect(store().worstCause()).toBe('unreachable')
  })

  // #8: the cause follows the latest classification within a streak.
  it('recordFailure updates the cause as the underlying error changes', () => {
    failN('a', 'unreachable', PERSISTENT_THRESHOLD)
    expect(store().worstCause()).toBe('unreachable')
    store().recordFailure('a', 'disk-full')
    expect(store().worstCause()).toBe('disk-full')
  })
})
