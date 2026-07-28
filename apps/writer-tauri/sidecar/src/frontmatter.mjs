// Minimal SKILL.md frontmatter reader for the skill-dedup list shown to
// the model. Deliberately dependency-free: only two known scalar keys
// (`name`, `description`) are needed, so a full YAML parser would be
// overkill for the shipped sidecar (see the app-side src/lib/frontmatter.ts
// for the real parser). Throws if the file is unreadable — callers skip.

import { readFile } from 'node:fs/promises'

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
