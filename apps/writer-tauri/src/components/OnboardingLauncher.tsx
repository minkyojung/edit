// First-run onboarding, shown in the launcher window BEFORE the VaultLauncher.
//
// This is the first screen a brand-new user sees — the launcher no longer
// appears until onboarding is done. The minimum viable step of the redesigned
// flow is: a welcome, then choosing WHERE notes live. Picking a folder is also
// the launcher's job, so we reuse its pick/create logic rather than duplicate
// it. `markBootstrapCompleted()` fires the moment a folder is chosen (or the
// user skips), so every later launch shows the normal VaultLauncher instead.
//
// Layout: a compact, centred window with a two-column split — copy + actions on
// the left, a preview panel on the right. The window is shrunk to onboarding
// size on mount and restored when we leave, so the returning-user launcher
// keeps the normal editor window size. Later steps (Claude connect, a seeded
// first note, the profile "aha") layer on from here without changing this gate.

import { useCallback, useEffect } from 'react'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { pickVault } from '@/lib/vaultPicker'
import {
  isTranslationProject,
  scaffoldTranslationProject,
} from '@/lib/translationProject'
import { openProjectWindow } from '@/lib/projectWindow'
import { useSettingsStore, type ProjectType } from '@/state/settingsStore'
import { WelcomePanel } from '@/profile/ui/onboarding/WelcomePanel'

// Compact onboarding window (width ≥ the 800 min in tauri.conf.json).
const ONBOARDING_W = 900
const ONBOARDING_H = 580

export function OnboardingLauncher() {
  const addRecentProject = useSettingsStore((s) => s.addRecentProject)
  const markBootstrapCompleted = useSettingsStore((s) => s.markBootstrapCompleted)

  // Shrink + centre the window for onboarding; restore the previous size when
  // we leave (skip / folder chosen → VaultLauncher or a project window).
  useEffect(() => {
    const win = getCurrentWindow()
    let prev: LogicalSize | null = null
    void (async () => {
      try {
        const size = await win.innerSize()
        const scale = await win.scaleFactor()
        prev = new LogicalSize(size.width / scale, size.height / scale)
        await win.setSize(new LogicalSize(ONBOARDING_W, ONBOARDING_H))
        await win.center()
      } catch {
        // Non-Tauri / unsupported — leave the window as-is.
      }
    })()
    return () => {
      if (prev) void win.setSize(prev).catch(() => {})
    }
  }, [])

  // Pick (or create) a folder to hold notes, then open it in its own window.
  // The native picker's "New Folder" affordance covers the create case, so a
  // brand-new user can make a fresh vault here. Mirrors VaultLauncher.openExisting.
  const chooseFolder = useCallback(async () => {
    const path = await pickVault()
    if (!path) return
    const type: ProjectType = (await isTranslationProject(path)) ? 'translation' : 'wiki'
    addRecentProject(path, type)
    markBootstrapCompleted()
    await openProjectWindow(path, folderName(path))
  }, [addRecentProject, markBootstrapCompleted])

  // Scaffold a fresh translation project (CLAUDE.md + manuscript/ + reference/).
  // Mirrors VaultLauncher.newTranslation.
  const newTranslation = useCallback(async () => {
    const path = await pickVault()
    if (!path) return
    await scaffoldTranslationProject(path)
    addRecentProject(path, 'translation')
    markBootstrapCompleted()
    await openProjectWindow(path, folderName(path))
  }, [addRecentProject, markBootstrapCompleted])

  return (
    <WelcomePanel
      onChooseFolder={() => void chooseFolder()}
      onNewTranslation={() => void newTranslation()}
      onSkip={markBootstrapCompleted}
    />
  )
}

/** Last path segment, for the project's display name. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
