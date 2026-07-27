// What the picker actually offers once the floor is applied.
//
// ModelSelect composes four rules (merge → account-gating → floor → recency
// split). This exercises that composition on the real catalog, since the rules
// interact: the floor must not drop a model the recency split would have shown,
// and neither may drop the one the user is currently on.

import { describe, expect, it } from 'vitest'
import { familyKey, meetsVersionFloor, mergeModelCatalog, splitByRecency, type ModelEntry } from './modelCatalog'
import { CHAT_MODELS } from './types'

/** GET /v1/models as of 2026-07-27, trimmed to the fields the picker reads. */
const LIVE: ModelEntry[] = [
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', createdAt: '2026-07-24T00:00:00Z', efforts: [] },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', createdAt: '2026-05-01T00:00:00Z', efforts: [] },
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', createdAt: '2026-06-01T00:00:00Z', efforts: [] },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', createdAt: '2026-04-01T00:00:00Z', efforts: [] },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', createdAt: '2026-03-01T00:00:00Z', efforts: [] },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', createdAt: '2026-02-01T00:00:00Z', efforts: [] },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', createdAt: '2026-01-01T00:00:00Z', efforts: [] },
  { id: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', createdAt: '2025-11-01T00:00:00Z', efforts: [] },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', createdAt: '2025-10-01T00:00:00Z', efforts: [] },
  { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', createdAt: '2025-09-29T00:00:00Z', efforts: [] },
  { id: 'claude-opus-4-1-20250805', displayName: 'Claude Opus 4.1', createdAt: '2025-08-05T00:00:00Z', efforts: [] },
]

/** The filter ModelSelect applies, minus the account-gating step (which needs
 * the SDK handshake payload and is exercised by its own path). */
function offered(selected: string): { primary: string[]; older: string[] } {
  const merged = mergeModelCatalog(CHAT_MODELS, LIVE)
  const visible = merged.filter(
    (m) => meetsVersionFloor(m.id) || familyKey(m.id) === familyKey(selected),
  )
  const { primary, older } = splitByRecency(visible, CHAT_MODELS)
  return { primary: primary.map((m) => m.id), older: older.map((m) => m.id) }
}

describe('the picker with the floor applied', () => {
  it('offers eight models and hides the three stale ones', () => {
    const { primary, older } = offered('claude-opus-4-8')
    const all = [...primary, ...older]
    expect(all).toHaveLength(8)
    expect(all).not.toContain('claude-opus-4-1-20250805')
    expect(all).not.toContain('claude-opus-4-5-20251101')
    expect(all).not.toContain('claude-sonnet-4-5-20250929')
  })

  it('keeps the built-in six up front and the two survivors under Older', () => {
    const { primary, older } = offered('claude-opus-4-8')
    expect(primary).toEqual([
      'claude-opus-5',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ])
    expect(older).toEqual(['claude-opus-4-7', 'claude-opus-4-6'])
  })
})

describe('the selected model is exempt from the floor', () => {
  // A thread pinned to Opus 4.1 must still render its own row, or the trigger
  // shows a checkmark against nothing and the user can't see what they're on.
  it('shows a below-floor model when it is the current one', () => {
    const { primary, older } = offered('claude-opus-4-1-20250805')
    expect([...primary, ...older]).toContain('claude-opus-4-1-20250805')
  })

  it('does not drag its below-floor siblings back in', () => {
    const all = Object.values(offered('claude-opus-4-1-20250805')).flat()
    expect(all).not.toContain('claude-sonnet-4-5-20250929')
    expect(all).not.toContain('claude-opus-4-5-20251101')
  })

  it('hides it again once the user moves off it', () => {
    const all = Object.values(offered('claude-opus-5')).flat()
    expect(all).not.toContain('claude-opus-4-1-20250805')
  })
})

describe('with no catalog', () => {
  // Offline / pre-login: the built-in list all clears the floor, so the picker
  // is exactly what it was before any of this existed.
  it('offers the built-in list untouched', () => {
    const merged = mergeModelCatalog(CHAT_MODELS, null)
    expect(merged.filter((m) => meetsVersionFloor(m.id))).toHaveLength(CHAT_MODELS.length)
  })
})
