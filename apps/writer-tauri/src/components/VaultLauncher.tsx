// First-run launcher / project picker. Rendered by BootGate in the
// launcher window (a window with no `?root` param). Two ways in:
//
//   - Recent       — reopen a project from the persisted list
//   - Open folder  — open any existing folder
//
// Window-per-project model: every entry point opens the project in its OWN
// window via openProjectWindow(), then hides itself. It reappears when the
// last project window closes (useWindowClose in AppContent).

import { useCallback } from 'react'
import { exists } from '@tauri-apps/plugin-fs'
import { Button } from '@/components/ui/button'
import { pickVault } from '@/lib/vaultPicker'
import { openProjectWindow, folderName } from '@/lib/projectWindow'
import { useSettingsStore, type RecentProject } from '@/state/settingsStore'

export function VaultLauncher() {
  const recentProjects = useSettingsStore((s) => s.recentProjects)
  const addRecentProject = useSettingsStore((s) => s.addRecentProject)
  const removeRecentProject = useSettingsStore((s) => s.removeRecentProject)

  // Open any existing folder. pickVault validates, then we open it in its own
  // window.
  const openExisting = useCallback(async () => {
    const path = await pickVault()
    if (!path) return
    addRecentProject(path)
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
      addRecentProject(p.path) // refresh lastOpened + move to front
      await openProjectWindow(p.path, folderName(p.path))
    },
    [addRecentProject, removeRecentProject],
  )

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-center text-2xl font-semibold tracking-tight text-foreground">
          Octave
        </h1>
        <p className="mb-6 text-center text-body text-muted-foreground">
          Open a project to get started.
        </p>

        {recentProjects.length > 0 && (
          <div className="mb-3 rounded-xl border bg-card p-2">
            <div className="px-3 py-1 text-footnote font-medium uppercase tracking-wide text-muted-foreground">
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
                  <div className="truncate text-body font-medium text-foreground">
                    {folderName(p.path)}
                  </div>
                  <div className="truncate text-footnote text-muted-foreground">
                    {p.path}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        <Button className="w-full" onClick={() => void openExisting()}>
          Open folder
        </Button>
      </div>
    </div>
  )
}
