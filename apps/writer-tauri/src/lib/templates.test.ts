// Integration check for the template pipeline the GUI drives: the one-click
// setup (seedStarterTemplates) → the loader (loadTemplates) → interpolation of
// what comes back. The GUI can only be verified by hand; this mocked-vault
// harness is the closest observable "does the flow actually run" short of a
// full dogfood boot. Interpolation itself is unit-tested in interpolate.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory vault: files (path → content) + folders (path set). The mock
// vault helpers read/write these so the real templates.ts logic runs unchanged.
const store = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  folder: '' as string, // getTemplatesFolder() return value
}))

vi.mock('@/lib/vault', () => ({
  listVaultDir: async (dir: string) => {
    if (!store.dirs.has(dir)) throw new Error(`no such dir: ${dir}`)
    const prefix = `${dir}/`
    const names = new Set<string>()
    for (const p of store.files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length)
        if (!rest.includes('/')) names.add(rest)
      }
    }
    return [...names]
  },
  readVaultFile: async (p: string) => {
    const c = store.files.get(p)
    if (c === undefined) throw new Error(`not found: ${p}`)
    return c
  },
  vaultFileExists: async (p: string) => store.files.has(p) || store.dirs.has(p),
  writeVaultFile: vi.fn(async (p: string, content: string) => {
    store.files.set(p, content)
  }),
  createVaultFolder: async (p: string) => {
    store.dirs.add(p)
  },
}))

vi.mock('@/state/settingsStore', () => ({
  getTemplatesFolder: () => store.folder,
}))

import {
  loadTemplates,
  seedStarterTemplates,
  STARTER_TEMPLATES_FOLDER,
} from './templates'
import { writeVaultFile } from '@/lib/vault'
import { interpolate } from './interpolate'

beforeEach(() => {
  store.files.clear()
  store.dirs.clear()
  store.folder = ''
  vi.mocked(writeVaultFile).mockClear()
})

describe('loadTemplates', () => {
  it('returns [] when no templates folder is configured', async () => {
    store.folder = ''
    expect(await loadTemplates()).toEqual([])
  })

  it('returns [] when the configured folder does not exist', async () => {
    store.folder = 'templates'
    expect(await loadTemplates()).toEqual([])
  })

  it('reads .md files, strips frontmatter, sorts by name, ignores non-md', async () => {
    store.folder = 'templates'
    store.dirs.add('templates')
    store.files.set('templates/Beta.md', '# Beta body')
    store.files.set('templates/Alpha.md', '---\nslug: x\n---\n# Alpha body')
    store.files.set('templates/notes.txt', 'ignored')

    const templates = await loadTemplates()
    expect(templates.map((t) => t.name)).toEqual(['Alpha', 'Beta'])
    // Frontmatter stripped, body trimmed.
    expect(templates[0].body).toBe('# Alpha body')
    expect(templates[1].body).toBe('# Beta body')
  })
})

describe('seedStarterTemplates', () => {
  it('creates the folder and a guide page that loadTemplates then surfaces', async () => {
    await seedStarterTemplates()
    // Point the setting where the GUI would after setup.
    store.folder = STARTER_TEMPLATES_FOLDER

    expect(store.dirs.has(STARTER_TEMPLATES_FOLDER)).toBe(true)
    const templates = await loadTemplates()
    expect(templates).toHaveLength(1)
    expect(templates[0].name).toBe('템플릿 안내')
    // The guide is the variable cheatsheet + examples.
    expect(templates[0].body).toContain('쓸 수 있는 변수')
    expect(templates[0].body).toContain('{{today}}')
    expect(templates[0].body).toContain('{{cursor}}')
  })

  it('is idempotent — never overwrites an existing guide', async () => {
    await seedStarterTemplates()
    expect(vi.mocked(writeVaultFile)).toHaveBeenCalledTimes(1)

    vi.mocked(writeVaultFile).mockClear()
    await seedStarterTemplates() // guide already present
    expect(vi.mocked(writeVaultFile)).not.toHaveBeenCalled()
  })

  it('the guide keeps its variable tokens literal (only interpolated on use)', async () => {
    // Reading/opening the guide must NOT resolve tokens — interpolation only
    // fires at insert/create time. So the seeded body still has raw tokens.
    await seedStarterTemplates()
    store.folder = STARTER_TEMPLATES_FOLDER
    const [guide] = await loadTemplates()
    expect(guide.body).toContain('{{today}}')

    // And when it IS interpolated, the tokens do resolve.
    const filled = interpolate(guide.body, { now: new Date(2026, 6, 14, 9, 5) })
    expect(filled).toContain('2026-07-14')
  })
})
