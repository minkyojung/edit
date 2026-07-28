// Bundled default vault assets — authored as real `.md` files and pulled into
// the app at build time via `import.meta.glob`. The boot seeders copy these into a
// fresh vault; the vault copy is what the SDK reads and the user edits.
//
// Why files, not TS string constants: one source of truth per asset, readable
// diffs, and the same authoring shape as the rest of the vault. The seeders
// consume `{ name, description, body }` — exactly what a parsed default is — so
// nothing downstream changes.

import { splitFrontmatter } from '@/lib/frontmatter'

/** A parsed default asset: frontmatter `name` + `description`, then the body
 * (the prompt / procedure). Shape matches what the seeders already accept. */
export interface DefaultAsset {
  name: string
  description: string
  body: string
  /** Optional frontmatter `model` — a role can run on a different model (e.g.
   * researcher → opus). Only agents use it; commands / skills leave it unset. */
  model?: string
}

function parseAssets(raw: Record<string, string>): DefaultAsset[] {
  return Object.entries(raw)
    .map(([path, text]) => {
      const { data, body } = splitFrontmatter(text)
      const fallbackName = path.split('/').pop()?.replace(/\.md$/, '') ?? ''
      const model = data.model ? String(data.model).trim() : undefined
      return {
        name: (data.name ?? fallbackName).trim(),
        description: (data.description ?? '').trim(),
        body: body.trim(),
        ...(model ? { model } : {}),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// NOTE: `import.meta.glob` is a compile-time macro — its options MUST be an
// inline object literal (a shared `const` fails Vite's transform), so the same
// `{ query, import, eager }` is repeated per call by necessity.
const SKILL_RAW = import.meta.glob('./skills/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const COMMAND_RAW = import.meta.glob('./commands/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const AGENT_RAW = import.meta.glob('./agents/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Default skills → seeded to `_system/agent/skills/<name>/SKILL.md`. */
export const DEFAULT_SKILLS: DefaultAsset[] = parseAssets(SKILL_RAW)
/** Default commands → seeded to `_system/agent/commands/<name>.md`. */
export const DEFAULT_COMMANDS: DefaultAsset[] = parseAssets(COMMAND_RAW)
/** Default agent roles → seeded to `_system/agent/agents/<name>.md`. */
export const DEFAULT_AGENTS: DefaultAsset[] = parseAssets(AGENT_RAW)

// The vault-root schema doc (`CLAUDE.md`) is a single whole-file default, not a
// name/description/body asset — surface it as a raw string.
const CLAUDE_MD_RAW = import.meta.glob('./CLAUDE.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
/** Default vault schema doc → seeded to `CLAUDE.md` at the vault root. */
export const DEFAULT_CLAUDE_MD: string = Object.values(CLAUDE_MD_RAW)[0] ?? ''
