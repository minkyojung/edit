import { describe, expect, it } from 'vitest'
import { appendToBackground } from './markers'

// appendToBackground is the fix for the "profile facts land after the
// user's ## Notes" bug: ingest / chat facts about the user must go INTO
// the ## Background zone, leaving every other zone (and the user's Notes)
// untouched.
describe('appendToBackground', () => {
  const profile = [
    '## About',
    '',
    'A writer.',
    '',
    '## Background',
    '',
    '- Works at Acme',
    '',
    '## Notes',
    '',
    'My private scratch.',
    '',
  ].join('\n')

  it('appends into the Background zone, not at end of file', () => {
    const out = appendToBackground(profile, '- Company: Discquiet')
    const bgIdx = out.indexOf('## Background')
    const notesIdx = out.indexOf('## Notes')
    const newIdx = out.indexOf('- Company: Discquiet')
    // The new bullet lands between the Background heading and Notes —
    // i.e. inside Background, never after the user's Notes.
    expect(newIdx).toBeGreaterThan(bgIdx)
    expect(newIdx).toBeLessThan(notesIdx)
  })

  it('preserves existing Background content and the user Notes', () => {
    const out = appendToBackground(profile, '- Company: Discquiet')
    expect(out).toContain('- Works at Acme')
    expect(out).toContain('- Company: Discquiet')
    expect(out).toContain('My private scratch.')
    // The About zone and its body are untouched.
    expect(out).toContain('## About')
    expect(out).toContain('A writer.')
  })

  it('creates a Background heading when the profile has none', () => {
    const bare = '## About\n\nA writer.\n'
    const out = appendToBackground(bare, '- Company: Discquiet')
    expect(out).toContain('## Background')
    expect(out.indexOf('## Background')).toBeGreaterThan(out.indexOf('## About'))
    expect(out).toContain('- Company: Discquiet')
  })

  it('is a no-op for blank input', () => {
    expect(appendToBackground(profile, '   ')).toBe(profile)
  })
})
