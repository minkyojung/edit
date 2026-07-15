import { describe, expect, it } from 'vitest'
import { folderOptions, DEFAULT_CAPTURE, DEFAULT_KNOWLEDGE_BASE } from './roleFolders'

describe('folderOptions', () => {
  it('always offers the two role defaults, even for an empty vault', () => {
    expect(folderOptions([])).toEqual([DEFAULT_CAPTURE, DEFAULT_KNOWLEDGE_BASE].sort())
  })

  it('includes the vault’s real folders alongside the defaults, sorted', () => {
    expect(folderOptions(['notes', 'clippings'])).toEqual([
      'clippings',
      'inbox',
      'notes',
      'wiki',
    ])
  })

  it('excludes app-managed and hidden folders', () => {
    // `_system` is app-managed; `.octave` / `.git` / `.obsidian` are hidden by
    // the dot-prefix filter. All are dropped; only real user folders remain.
    expect(folderOptions(['_system', '.octave', '.git', '.obsidian', 'research'])).toEqual([
      'inbox',
      'research',
      'wiki',
    ])
  })

  it('de-duplicates when a real folder equals a default', () => {
    expect(folderOptions(['wiki', 'inbox', 'notes'])).toEqual([
      'inbox',
      'notes',
      'wiki',
    ])
  })
})
