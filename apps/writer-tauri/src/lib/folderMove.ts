// Pure planning for an external/drag folder move. Extracted so the
// cycle guard — the part that must never regress — is unit-testable
// without the store or filesystem. A folder move keeps the folder's leaf
// name and only changes its parent; the heavy relocation (disk rename,
// rewriting contained docs) lives in docsStore's relocateFolder.

export type FolderMovePlan =
  | { kind: 'noop' } // already sits under the target parent
  | { kind: 'reject' } // dropped on itself or one of its descendants
  | { kind: 'move'; newPath: string }

/** Decide the result of moving `folderPath` into `destParent` (''=vault
 * root). Rejects dropping a folder onto itself or into its own subtree
 * (an fs rename of a dir into its child would corrupt/fail). Returns a
 * no-op when the folder already lives directly under `destParent`. */
export function planFolderMove(folderPath: string, destParent: string): FolderMovePlan {
  if (destParent === folderPath) return { kind: 'reject' }
  if (destParent.startsWith(`${folderPath}/`)) return { kind: 'reject' }
  const leaf = folderPath.slice(folderPath.lastIndexOf('/') + 1)
  const newPath = destParent ? `${destParent}/${leaf}` : leaf
  if (newPath === folderPath) return { kind: 'noop' }
  return { kind: 'move', newPath }
}
