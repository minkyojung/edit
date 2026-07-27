// Minimal SKILL.md frontmatter reader for the skill-dedup list shown to
// the model. Deliberately dependency-free: only two known scalar keys
// (`name`, `description`) are needed, so a full YAML parser would be
// overkill for the shipped sidecar (see the app-side src/lib/frontmatter.ts
// for the real parser). Throws if the file is unreadable — callers skip.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Read `name` and `description` from a SKILL.md's YAML frontmatter.
 * `name` falls back to `fallbackName` (the folder name) when absent.
 *
 * @param {string} skillMdPath  absolute path to the SKILL.md
 * @param {string} fallbackName folder name used when `name:` is missing
 * @returns {Promise<{ name: string, description: string }>}
 */
export async function readSkillMeta(skillMdPath, fallbackName) {
  const raw = await readFile(skillMdPath, 'utf-8')
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const pick = (k) =>
    fm
      .split('\n')
      .find((l) => l.startsWith(`${k}:`))
      ?.slice(k.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '') ?? ''
  return { name: pick('name') || fallbackName, description: pick('description') }
}

/** Pull one scalar key out of a YAML frontmatter block, unquoted. */
function fmValue(fm, key) {
  const line = fm.split('\n').find((l) => new RegExp(`^${key}\\s*:`).test(l))
  if (!line) return ''
  return line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replace(/^["']|["']$/g, '')
}

/**
 * Names of the agents under `<pluginRoot>/agents/` declared `background: true`
 * — the fire-and-forget kind, whose work outlives the turn that spawned it.
 *
 * The host has to work this out for itself, because the SDK won't say. Measured
 * on SDK 0.3.187 / CLI 2.1.187 (2026-07-27):
 *   - `task_started` carries no background flag at all.
 *   - `task_updated.patch.is_backgrounded` exists in the types but never
 *     arrives for a `background: true` agent.
 *   - The documented surface — the Stop hook's `background_tasks` snapshot —
 *     reports an ORDINARY blocking subagent as `status: "running"` on later
 *     turns, long after it finished, so it can't separate the two kinds either.
 *
 * Agent files are ours, in our own vault, so their frontmatter is the one
 * signal we can trust. Used to avoid counting a blocking subagent as
 * outstanding background work — see `#trackBackground` in server.mjs.
 *
 * Best-effort by design: an unreadable agents/ dir or file yields an empty or
 * partial set, which degrades toward today's behaviour (count it, keep the
 * thread alive) rather than toward the dangerous direction (reap a thread whose
 * background work is still running).
 *
 * @param {string} pluginRoot absolute path to `<vault>/_system/agent`
 * @returns {Promise<Set<string>>} agent names, e.g. `Set { 'researcher' }`
 */
export async function readBackgroundAgentNames(pluginRoot) {
  const out = new Set()
  let entries
  try {
    entries = await readdir(join(pluginRoot, 'agents'), { withFileTypes: true })
  } catch {
    return out // no agents/ dir → nothing is background
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    try {
      const raw = await readFile(join(pluginRoot, 'agents', e.name), 'utf-8')
      const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
      if (fmValue(fm, 'background') !== 'true') continue
      out.add(fmValue(fm, 'name') || e.name.replace(/\.md$/, ''))
    } catch {
      // Unreadable agent file → leave it unknown, which means "counted".
    }
  }
  return out
}
