// First-run onboarding, shown in the launcher window BEFORE the VaultLauncher.
//
// This is the first screen a brand-new user sees — the launcher no longer
// appears until onboarding is done. Flow: welcome → connect → folder → done.
// Folder is mandatory (no skip); picking one only STORES the choice, so the
// completion panel can confirm before the project window opens. `openProject`
// (from the done panel) is what actually spawns the window + marks onboarding
// complete, so every later launch shows the normal VaultLauncher instead.
//
// Panels are pure presentation under src/profile/ui/onboarding/ — the same ones
// the /onboard design-preview renders, so layout can be iterated without
// restarting. This wrapper owns the window sizing, the step state, and the real
// folder-pick / project-open behaviour.

import { useCallback, useEffect, useState } from 'react'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { pickVault } from '@/lib/vaultPicker'
import { isTranslationProject } from '@/lib/translationProject'
import { openProjectWindow } from '@/lib/projectWindow'
import { useSettingsStore, type ProjectType } from '@/state/settingsStore'
import { WelcomePanel } from '@/profile/ui/onboarding/WelcomePanel'
import { ConnectPanel } from '@/profile/ui/onboarding/ConnectPanel'
import { FolderPanel } from '@/profile/ui/onboarding/FolderPanel'
import { DonePanel } from '@/profile/ui/onboarding/DonePanel'

// Compact onboarding window (width ≥ the 800 min in tauri.conf.json).
const ONBOARDING_W = 900
const ONBOARDING_H = 580

type Step = 'welcome' | 'connect' | 'folder' | 'done'

export function OnboardingLauncher() {
  const addRecentProject = useSettingsStore((s) => s.addRecentProject)
  const markBootstrapCompleted = useSettingsStore((s) => s.markBootstrapCompleted)

  const [step, setStep] = useState<Step>('welcome')
  const [chosen, setChosen] = useState<{ path: string; type: ProjectType } | null>(null)

  // Shrink + centre the window for onboarding; restore the previous size when
  // we leave (project window opened).
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

  // Mandatory folder choice: pick (or create) a folder, remember it, and advance
  // to the completion step. The native picker's "New Folder" affordance covers
  // the create case. Detecting an existing translation project keeps that path
  // working even though onboarding no longer scaffolds new ones.
  const chooseFolder = useCallback(async () => {
    const path = await pickVault()
    if (!path) return
    const type: ProjectType = (await isTranslationProject(path)) ? 'translation' : 'wiki'
    setChosen({ path, type })
    setStep('done')
  }, [])

  // Finish: record the project, mark onboarding done, open it in its own window.
  const openProject = useCallback(async () => {
    if (!chosen) return
    addRecentProject(chosen.path, chosen.type)
    markBootstrapCompleted()
    await openProjectWindow(chosen.path, folderName(chosen.path))
  }, [chosen, addRecentProject, markBootstrapCompleted])

  if (step === 'welcome') {
    return <WelcomePanel onGetStarted={() => setStep('connect')} />
  }
  if (step === 'connect') {
    // Rough: both actions advance. Real OAuth wiring (ConnectClaudeDialog) lands
    // in polish.
    return (
      <ConnectPanel
        onConnect={() => setStep('folder')}
        onLater={() => setStep('folder')}
      />
    )
  }
  if (step === 'folder') {
    return <FolderPanel onChooseFolder={() => void chooseFolder()} />
  }
  return <DonePanel onEnter={() => void openProject()} />
}

/** Last path segment, for the project's display name. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
