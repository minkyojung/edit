// Dev-only feature flags read from localStorage. Mirrors the
// `writer.cmEditor` pattern in Page.tsx.

/** Obsidian-style folder tree: when on, the sidebar renders a folder
 * tree (FolderTree) AND scanVault includes every `.md` in the vault as a
 * generic `note` (not just the recognised folders). Off = current
 * behaviour, untouched.
 *
 *   localStorage.setItem('writer.folderTree', '1') + reload
 */
export function folderTreeFlag(): boolean {
  return (
    import.meta.env.DEV &&
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('writer.folderTree') === '1'
  )
}
