// Folder options for the onboarding "roles" step. The step reads the
// picked vault's top-level folders and lets the user pick which one is
// the knowledge base and which is the capture inbox — no AI, just the
// real directory listing plus the two role defaults.

/** Role defaults, matching the settings-store defaults so a fresh /
 * empty vault has a valid selection with no folders on disk yet (the
 * folders come into existence on first write). */
export const DEFAULT_KNOWLEDGE_BASE = 'wiki'
export const DEFAULT_CAPTURE = 'inbox'

/** App-managed folders that are never role targets — excluded from the
 * dropdowns. `_system` (host bookkeeping) and `threads` (chat storage)
 * mirror the sidebar's hidden set; dot-folders (`.git`, `.obsidian`)
 * are filtered by name. */
const EXCLUDED_ROLE_DIRS = new Set(['_system', 'threads'])

/** Build the selectable folder list for the role dropdowns: the vault's
 * real top-level folders (minus app-managed + hidden ones) plus the two
 * role defaults, de-duplicated and alphabetically sorted so both
 * dropdowns always offer a valid, stable choice.
 *
 * `scanned` is the list of immediate subdirectory names from `readDir`
 * on the picked vault root (empty for a brand-new vault). Pure —
 * exported for unit tests. */
export function folderOptions(scanned: string[]): string[] {
  const usable = scanned.filter(
    (name) => !name.startsWith('.') && !EXCLUDED_ROLE_DIRS.has(name),
  )
  return [...new Set([DEFAULT_KNOWLEDGE_BASE, DEFAULT_CAPTURE, ...usable])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}
