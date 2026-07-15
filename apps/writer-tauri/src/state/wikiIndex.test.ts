import { describe, expect, it } from 'vitest'
import type { KnownDoc } from './docsStore'
import {
  bodyExcerpt,
  countBacklinks,
  folderOf,
  orderSections,
  pickEmptyFolders,
  renderVaultIndex,
  type IndexRow,
  type IndexSection,
} from './wikiIndex'
import { extractWikilinks } from '@/lib/wikilinkResolve'

function wiki(slug: string, title: string, opts: Partial<KnownDoc> = {}): KnownDoc {
  return {
    slug,
    type: `wiki:custom-${slug}` as KnownDoc['type'],
    title,
    ...opts,
  }
}

function system(slug: string, name: string): KnownDoc {
  return {
    slug,
    type: `system:${name}` as KnownDoc['type'],
    title: name,
  }
}

describe('extractWikilinks', () => {
  it('extracts a single bracket token', () => {
    expect(extractWikilinks('See [[Sarah]] for details.')).toEqual(['Sarah'])
  })

  it('extracts every occurrence including duplicates', () => {
    expect(extractWikilinks('[[Sarah]] and [[Sarah]] again, plus [[Acme]].')).toEqual([
      'Sarah',
      'Sarah',
      'Acme',
    ])
  })

  it('trims whitespace inside brackets', () => {
    expect(extractWikilinks('[[  Sarah  ]] and [[Acme Corp]]')).toEqual([
      'Sarah',
      'Acme Corp',
    ])
  })

  it('skips empty / whitespace-only brackets', () => {
    expect(extractWikilinks('[[]] and [[   ]] and [[Real]]')).toEqual(['Real'])
  })

  it('does not span newlines inside one token', () => {
    expect(extractWikilinks('[[bad\nbreak]] but [[good]]')).toEqual(['good'])
  })

  it('returns empty array when no brackets present', () => {
    expect(extractWikilinks('plain text with no wikilinks')).toEqual([])
  })
})

describe('countBacklinks', () => {
  it('counts a single inbound link', () => {
    const catalog = [wiki('a', 'Sarah'), wiki('b', 'Acme')]
    const bodies: Record<string, string> = {
      a: '',
      b: 'Worked with [[Sarah]] today.',
    }
    const counts = countBacklinks(catalog, (s) => bodies[s])
    expect(counts.get('a')).toBe(1)
    expect(counts.has('b')).toBe(false)
  })

  it('counts duplicate references in the same body as separate backlinks', () => {
    const catalog = [wiki('a', 'Sarah'), wiki('b', 'Notes')]
    const bodies: Record<string, string> = {
      a: '',
      b: '[[Sarah]] said this. [[Sarah]] also said that.',
    }
    const counts = countBacklinks(catalog, (s) => bodies[s])
    expect(counts.get('a')).toBe(2)
  })

  it('is case-insensitive on title matching', () => {
    const catalog = [wiki('a', 'Sarah Kim'), wiki('b', 'Other')]
    const bodies: Record<string, string> = {
      a: '',
      b: 'see [[sarah kim]] and [[SARAH KIM]]',
    }
    expect(countBacklinks(catalog, (s) => bodies[s]).get('a')).toBe(2)
  })

  it('skips self-references', () => {
    const catalog = [wiki('a', 'Sarah')]
    const bodies: Record<string, string> = {
      a: 'I, [[Sarah]], am Sarah.',
    }
    expect(countBacklinks(catalog, (s) => bodies[s]).has('a')).toBe(false)
  })

  it('excludes system:* pages from the resolution map', () => {
    const catalog = [
      system('cv', 'Conventions'),
      wiki('b', 'Notes'),
    ]
    const bodies: Record<string, string> = {
      cv: '',
      b: 'do not link [[Conventions]] anywhere',
    }
    expect(countBacklinks(catalog, (s) => bodies[s]).has('cv')).toBe(false)
  })

  it('skips docs with no body content', () => {
    const catalog = [wiki('a', 'Sarah'), wiki('b', 'Empty')]
    const counts = countBacklinks(catalog, (slug) => (slug === 'b' ? null : ''))
    expect(counts.size).toBe(0)
  })

  it('skips system source pages by way of their archived-or-system filter not applying — they\'re catalog entries, links FROM them still count', () => {
    // A system:* page's body links to a wiki page: the link still
    // counts (we only exclude system:* as a TARGET because the LLM is
    // told not to link to them; system:log etc. can legitimately
    // mention real wiki pages and those references are useful signal).
    const catalog = [
      wiki('a', 'Sarah'),
      system('log', 'log'),
    ]
    const bodies: Record<string, string> = {
      a: '',
      log: '[2026-05-19] noted [[Sarah]]',
    }
    expect(countBacklinks(catalog, (s) => bodies[s]).get('a')).toBe(1)
  })

  it('handles multiple targets across multiple sources', () => {
    const catalog = [
      wiki('s', 'Sarah'),
      wiki('a', 'Acme'),
      wiki('d', 'Daily-ish'),
    ]
    const bodies: Record<string, string> = {
      s: 'I work at [[Acme]].',
      a: '',
      d: 'Met [[Sarah]] at [[Acme]]. Then [[Sarah]] again.',
    }
    const counts = countBacklinks(catalog, (s) => bodies[s])
    expect(counts.get('s')).toBe(2)
    expect(counts.get('a')).toBe(2)
  })
})

describe('folderOf', () => {
  it('keys a note on its containing folder', () => {
    expect(folderOf('wiki/Sarah.md')).toBe('wiki')
    expect(folderOf('research/2024/paper.md')).toBe('research/2024')
    expect(folderOf('inbox/clip.md')).toBe('inbox')
  })

  it('keys a root-level note on the empty string', () => {
    expect(folderOf('CLAUDE.md')).toBe('')
  })

  it('collapses every daily note into one `daily` section', () => {
    expect(folderOf('daily/2026-01-01.md')).toBe('daily')
    expect(folderOf('daily/2026-01-01/Note.md')).toBe('daily')
  })
})

describe('orderSections', () => {
  function section(folder: string): IndexSection {
    return { folder, role: null, rows: [], attachments: [] }
  }

  it('orders knowledge base → capture → others (alpha) → daily last', () => {
    const ordered = orderSections(
      [
        section('daily'),
        section('research'),
        section('inbox'),
        section('wiki'),
        section('archive'),
      ],
      'wiki',
      'inbox',
    )
    expect(ordered.map((s) => s.folder)).toEqual([
      'wiki',
      'inbox',
      'archive',
      'research',
      'daily',
    ])
  })

  it('is a pure copy — does not mutate its input', () => {
    const input = [section('b'), section('a')]
    const before = input.map((s) => s.folder)
    orderSections(input, 'wiki', 'inbox')
    expect(input.map((s) => s.folder)).toEqual(before)
  })
})

describe('renderVaultIndex', () => {
  function row(path: string, title: string, summary = 's', links = 0): IndexRow {
    return { path, title, summary, links }
  }
  function section(
    folder: string,
    rows: IndexRow[],
    opts: Partial<IndexSection> = {},
  ): IndexSection {
    return { folder, role: null, rows, attachments: [], ...opts }
  }

  it('renders a folder heading with role label + count over a table', () => {
    const out = renderVaultIndex([
      section('wiki', [row('wiki/Sarah.md', 'Sarah', 'Engineer', 3)], {
        role: 'knowledge base',
      }),
    ])
    expect(out).toContain('## wiki/ — knowledge base (1)')
    expect(out).toContain('| Path | Title | Summary | Links |')
    expect(out).toContain('| wiki/Sarah.md | Sarah | Engineer | 3 |')
  })

  it('labels the root section with `/` and no role', () => {
    const out = renderVaultIndex([section('', [row('CLAUDE.md', 'CLAUDE')])])
    expect(out).toContain('## / (1)')
  })

  it('escapes pipe characters in cells so a title cannot break the row', () => {
    const out = renderVaultIndex([section('wiki', [row('wiki/A.md', 'A | B')])])
    expect(out).toContain('A \\| B')
  })

  it('lists attachments under a folder', () => {
    const out = renderVaultIndex([
      section('research', [], { attachments: ['research/paper.pdf'] }),
    ])
    expect(out).toContain('**Attachments**')
    expect(out).toContain('- research/paper.pdf')
  })

  it('marks a folder with no notes and no attachments as empty', () => {
    const out = renderVaultIndex([section('drafts', [])])
    expect(out).toContain('## drafts/ (0)')
    expect(out).toContain('_(empty folder)_')
  })

  it('returns a placeholder when the vault has no notes', () => {
    expect(renderVaultIndex([])).toBe('_The vault has no notes yet._')
  })
})

describe('pickEmptyFolders', () => {
  it('returns folders with no notes/attachments and no populated descendant', () => {
    const empties = pickEmptyFolders(
      ['wiki', 'drafts', 'research', 'research/2024'],
      new Set(['wiki', 'research/2024']),
    )
    // drafts is genuinely empty; research is a parent of a populated
    // subfolder so it's NOT empty; wiki + research/2024 are populated.
    expect(empties).toEqual(['drafts'])
  })

  it('excludes host-owned and dated areas', () => {
    // App-internal state lives under `.octave/` (dot-prefixed) and never
    // reaches the catalog. `threads/` is not dot-prefixed, so it DOES reach
    // knownFolders (it holds only .json/.turns.jsonl, never notes) and must be
    // dropped alongside `_system` + dated `daily/` areas.
    const empties = pickEmptyFolders(
      ['', '_system', '_system/agent', 'daily', 'daily/2026-01-01', 'threads', 'notes'],
      new Set(),
    )
    expect(empties).toEqual(['notes'])
  })
})

describe('bodyExcerpt', () => {
  it('skips the title line and returns the next content line', () => {
    expect(bodyExcerpt('Sarah Kim\n\nVP of Operations, joined Q1 2024.')).toBe(
      'VP of Operations, joined Q1 2024.',
    )
  })

  it('returns null when body has only one non-empty line (just the title)', () => {
    expect(bodyExcerpt('Sarah Kim')).toBeNull()
    expect(bodyExcerpt('Sarah Kim\n\n  \n')).toBeNull()
  })

  it('returns null when body is entirely empty', () => {
    expect(bodyExcerpt('')).toBeNull()
    expect(bodyExcerpt('\n\n\n')).toBeNull()
  })

  it('trims the returned excerpt', () => {
    expect(bodyExcerpt('Title\n   indented content   ')).toBe('indented content')
  })

  it('skips zero-width-only lines when counting the title', () => {
    expect(bodyExcerpt('​\nReal Title\n\nActual content')).toBe('Actual content')
  })
})
