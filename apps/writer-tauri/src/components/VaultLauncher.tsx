// First-run launcher / project picker. Rendered by BootGate in the
// launcher window (a window with no `?root` param). Three ways in:
//
//   - Recent       — reopen a project from the persisted list
//   - New translation project — scaffold a fresh translation folder
//   - Open folder  — open any existing folder (wiki or translation)
//
// Window-per-project model: every entry point opens the project in its OWN
// window via openProjectWindow(). The launcher itself never boots a vault —
// it stays open as the hub. (Closing the launcher / reopening it when the
// last project window closes is window-lifecycle polish for a later phase.)

import { useCallback, useEffect } from 'react'
import { exists } from '@tauri-apps/plugin-fs'
import { Button } from '@/components/ui/button'
import { pickVault } from '@/lib/vaultPicker'
import {
  isTranslationProject,
  scaffoldTranslationProject,
} from '@/lib/translationProject'
import { openProjectWindow } from '@/lib/projectWindow'
import {
  useSettingsStore,
  type ProjectType,
  type RecentProject,
} from '@/state/settingsStore'

export function VaultLauncher() {
  const recentProjects = useSettingsStore((s) => s.recentProjects)
  const addRecentProject = useSettingsStore((s) => s.addRecentProject)
  const removeRecentProject = useSettingsStore((s) => s.removeRecentProject)

  // One-time migration: a legacy single-vault path (from before
  // window-per-project) won't be in the recent list. Surface it as a recent
  // so existing users can one-click reopen their old vault instead of
  // hunting for it with "Open folder".
  useEffect(() => {
    const { vaultPaths, recentProjects: recents } = useSettingsStore.getState()
    const legacy = vaultPaths[0]
    if (!legacy || recents.some((p) => p.path === legacy)) return
    void (async () => {
      const type: ProjectType = (await isTranslationProject(legacy))
        ? 'translation'
        : 'wiki'
      addRecentProject(legacy, type)
    })()
  }, [addRecentProject])

  // Open any existing folder. pickVault validates; we detect the project
  // type for the recent list, then open it in its own window.
  const openExisting = useCallback(async () => {
    const path = await pickVault()
    if (!path) return
    const type: ProjectType = (await isTranslationProject(path))
      ? 'translation'
      : 'wiki'
    addRecentProject(path, type)
    await openProjectWindow(path, folderName(path))
  }, [addRecentProject])

  // Create a new translation project: pick/create a folder, lay down the
  // translation CLAUDE.md + manuscript/ + reference/ skeleton, then open it in
  // its own window.
  const newTranslation = useCallback(async () => {
    const path = await pickVault()
    if (!path) return
    await scaffoldTranslationProject(path)
    addRecentProject(path, 'translation')
    await openProjectWindow(path, folderName(path))
  }, [addRecentProject])

  // Reopen a recent project. Prune the entry if its folder is gone (moved,
  // deleted, unmounted drive) so the list self-heals.
  const openRecent = useCallback(
    async (p: RecentProject) => {
      if (!(await exists(p.path))) {
        removeRecentProject(p.path)
        return
      }
      addRecentProject(p.path, p.type) // refresh lastOpened + move to front
      await openProjectWindow(p.path, folderName(p.path))
    },
    [addRecentProject, removeRecentProject],
  )

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-center text-2xl font-semibold tracking-tight text-foreground">
          Writer
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          Open a project to get started.
        </p>

        {recentProjects.length > 0 && (
          <div className="mb-3 rounded-xl border bg-card p-2">
            <div className="px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent
            </div>
            {recentProjects.map((p) => (
              <button
                key={p.path}
                type="button"
                onClick={() => void openRecent(p)}
                className="flex w-full items-center justify-between gap-4 rounded-lg p-3 text-left hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {folderName(p.path)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.path}
                  </div>
                </div>
                <span className="flex-none text-xs text-muted-foreground">
                  {p.type === 'translation' ? 'Translation' : 'Wiki'}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => void newTranslation()}>
            New translation project
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => void openExisting()}
          >
            Open folder
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Last path segment, for the project's display name. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
