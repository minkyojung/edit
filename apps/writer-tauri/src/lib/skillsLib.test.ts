// A skill's catalog slug has to come from its PATH, not from its file.
//
// `listSkills` used to read `slug` out of the SKILL.md frontmatter, and
// `SkillsPage` disabled its open button when that came back empty. But the slug
// is ephemeral: `scanVault.ts` says it is "never persisted, never written to
// the file", and `portableFrontmatterFields` lists `slug: undefined` so the
// flush actively strips it. Any `slug:` still in a SKILL.md is a leftover from
// a previous session — a value this session's catalog has never heard of. So
// the button was either disabled or pointed at nothing.
//
// Driven against a real catalog built by the real scanVault over a fake disk,
// because the claim under test is "the skill is in the catalog and reachable by
// path", which only a real scan can establish.

import { describe, expect, it, vi } from 'vitest'

const entry = (name: string, kind: 'dir' | 'file') => ({
  name,
  isDirectory: kind === 'dir',
  isFile: kind === 'file',
  isSymlink: false,
})

const disk = vi.hoisted(() => ({
  dirs: new Map<string, unknown[]>(),
  text: new Map<string, string>(),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: async (abs: string) => {
    const e = disk.dirs.get(abs)
    if (!e) throw new Error(`ENOTDIR ${abs}`)
    return e
  },
  exists: async (abs: string) => disk.dirs.has(abs) || disk.text.has(abs),
  readTextFile: async (abs: string) => {
    const v = disk.text.get(abs)
    if (v === undefined) throw new Error(`ENOENT ${abs}`)
    return v
  },
  readFile: async (abs: string) => new TextEncoder().encode(disk.text.get(abs) ?? ''),
  writeTextFile: async () => {},
  writeFile: async () => {},
  rename: async () => {},
  remove: async () => {},
  mkdir: async () => {},
}))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
  dirname: async (p: string) => p.split('/').slice(0, -1).join('/'),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => {} }))
vi.mock('@tauri-apps/plugin-shell', () => ({ open: async () => {} }))
vi.mock('@/state/settingsStore', () => ({ getActiveVaultPath: () => '/vault' }))
vi.mock('@/state/gitStore', () => ({
  useGitStore: { getState: () => ({ noteActivity: () => {} }) },
}))
vi.mock('@/lib/docFileSync', () => ({ seedLastWrittenPath: () => {} }))

import { scanVault } from './scanVault'
import { skillDocSlug, skillMdPath } from './skillsLib'

const STALE = 'stale-from-last-session'

/** A skill exactly as this vault has them: no `name:`, and a `slug:` left over
 *  from before the cleanup that stopped writing it. */
function seedDisk() {
  disk.dirs = new Map<string, unknown[]>([
    ['/vault', [entry('_system', 'dir')]],
    ['/vault/_system', [entry('agent', 'dir')]],
    ['/vault/_system/agent', [entry('skills', 'dir')]],
    ['/vault/_system/agent/skills', [entry('existing', 'dir')]],
    ['/vault/_system/agent/skills/existing', [entry('SKILL.md', 'file')]],
  ])
  disk.text = new Map([
    [
      `/vault/${skillMdPath('existing')}`,
      `---\nslug: ${STALE}\ndescription: when to use it\n---\n\nthe procedure\n`,
    ],
  ])
}

describe('skillDocSlug', () => {
  it('resolves a slug this session actually knows, not the one in the file', async () => {
    seedDisk()
    const { docs } = await scanVault()

    const slug = skillDocSlug('existing', docs)

    // Load-bearing: this is precisely what makes the open button work. A slug
    // the catalog does not contain opens nothing, which is what reading the
    // file's own `slug:` produced.
    expect(docs.some((d) => d.slug === slug)).toBe(true)
    expect(slug).not.toBe(STALE)
  })

  it('returns null for a folder the catalog has no note for', async () => {
    seedDisk()
    const { docs } = await scanVault()
    expect(skillDocSlug('never-scanned', docs)).toBeNull()
  })
})
