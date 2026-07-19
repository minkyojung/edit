import { describe, expect, it } from 'vitest'
import { visibleProps } from './PropertiesPanel'

describe('visibleProps', () => {
  it('always shows status, even on a bare note', () => {
    expect(visibleProps({})).toEqual(['status'])
  })

  it('adds created when the note has a creation date', () => {
    expect(visibleProps({ createdAt: '2026-06-11T00:00:00.000Z' })).toEqual([
      'status',
      'created',
    ])
  })

  it('adds source + read for a captured note (has sourceUrl)', () => {
    expect(
      visibleProps({
        createdAt: '2026-06-11T00:00:00.000Z',
        sourceUrl: 'https://example.com/a',
      }),
    ).toEqual(['status', 'created', 'source', 'read'])
  })

  it('shows source + read without created when only sourceUrl is present', () => {
    expect(visibleProps({ sourceUrl: 'https://example.com/a' })).toEqual([
      'status',
      'source',
      'read',
    ])
  })
})
