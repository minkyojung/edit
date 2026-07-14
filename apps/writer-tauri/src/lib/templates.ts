// Vault templates — user-authored `.md` files in the templates folder
// (configurable in settings, default `templates/`) become insertable snippets.
// The same template feeds two surfaces:
//   • editor slash menu (`/`)     — insert the body at the cursor
//   • command palette (⌘K)        — create a whole new note from the body
//
// A template's BODY is the exact markdown inserted; frontmatter is stripped so a
// template can carry its own `.md` metadata without leaking into the target. The
// folder is a plain Obsidian-style convention: nothing scaffolds it, and a
// missing / empty folder simply yields zero templates (no error).

import { listVaultDir, readVaultFile } from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { getTemplatesFolder } from '@/state/settingsStore'
import { setTemplateSlashItems, templateSlashItem } from '@/prototypes/slashCommands'

export interface Template {
  /** Filename without `.md` — the label shown in menus. */
  name: string
  /** Markdown body (frontmatter stripped, trimmed). The exact text inserted. */
  body: string
}

/** Read every `.md` in the templates folder, sorted by name. Returns `[]` when
 * no vault is selected, the folder doesn't exist yet, or it holds no templates.
 * Never throws — a broken template folder must not break the editor or palette. */
export async function loadTemplates(): Promise<Template[]> {
  const folder = getTemplatesFolder()
  if (!folder) return [] // no templates folder configured
  let names: string[]
  try {
    names = await listVaultDir(folder)
  } catch {
    // Folder missing (never created) or no vault — no templates yet.
    return []
  }
  const templates: Template[] = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    try {
      const raw = await readVaultFile(`${folder}/${file}`)
      templates.push({
        name: file.replace(/\.md$/, ''),
        body: splitFrontmatter(raw).body.trim(),
      })
    } catch {
      // Unreadable template — skip it rather than fail the whole load.
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load the vault's templates and push them into the slash menu's item list.
 * Called on editor mount so `/` surfaces the current templates. Cheap; safe to
 * call repeatedly. */
export async function refreshTemplateSlashItems(): Promise<void> {
  const templates = await loadTemplates()
  setTemplateSlashItems(templates.map(templateSlashItem))
}
