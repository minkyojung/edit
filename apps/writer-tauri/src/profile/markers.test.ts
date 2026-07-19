import { describe, expect, it } from 'vitest'
import { appendToBackground, splitOutBackground } from './markers'

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

// splitOutBackground keeps the bounded summary zones always-on and carves out
// the growing ## Background for on-demand loading.
describe('splitOutBackground', () => {
  const profile = [
    '## About',
    '',
    'A writer.',
    '',
    '## Background',
    '',
    '- Works at Acme',
    '- Lives in Seoul',
    '',
    '## Notes',
    '',
    'My private scratch.',
    '',
  ].join('\n')

  it('removes the Background zone from the summary but keeps the other zones', () => {
    const { summary } = splitOutBackground(profile)
    expect(summary).toContain('## About')
    expect(summary).toContain('A writer.')
    expect(summary).toContain('## Notes')
    expect(summary).toContain('My private scratch.')
    // Background heading + body are gone from the summary.
    expect(summary).not.toContain('## Background')
    expect(summary).not.toContain('Works at Acme')
  })

  it('returns the Background body separately', () => {
    const { background } = splitOutBackground(profile)
    expect(background).toBe('- Works at Acme\n- Lives in Seoul')
  })

  it('returns empty background and unchanged summary when there is no Background zone', () => {
    const bare = '## About\n\nA writer.\n'
    const { summary, background } = splitOutBackground(bare)
    expect(background).toBe('')
    expect(summary).toContain('A writer.')
  })

  it('handles a profile that is ONLY a Background zone', () => {
    const onlyBg = '## Background\n\n- Fact one\n- Fact two\n'
    const { summary, background } = splitOutBackground(onlyBg)
    expect(summary).toBe('')
    expect(background).toBe('- Fact one\n- Fact two')
  })
})
