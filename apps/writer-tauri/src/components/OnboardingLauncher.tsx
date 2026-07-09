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
import { openProjectWindow, folderName } from '@/lib/projectWindow'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useSettingsStore, type ProjectType } from '@/state/settingsStore'
import { WelcomePanel } from '@/profile/ui/onboarding/WelcomePanel'
import { ConnectPanel } from '@/profile/ui/onboarding/ConnectPanel'
import { FolderPanel } from '@/profile/ui/onboarding/FolderPanel'
import { DonePanel } from '@/profile/ui/onboarding/DonePanel'
import { ONBOARDING_W, ONBOARDING_H } from '@/profile/ui/onboarding/onboardingWindow'

type Step = 'welcome' | 'connect' | 'folder' | 'done'

export function OnboardingLauncher() {
  const addRecentProject = useSettingsStore((s) => s.addRecentProject)
  const markBootstrapCompleted = useSettingsStore((s) => s.markBootstrapCompleted)

  const { connect: connectGoogle, connecting: googleConnecting } = useGoogleAuth()

  const [step, setStep] = useState<Step>('welcome')
  const [chosen, setChosen] = useState<{ path: string; type: ProjectType } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

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
        // Lower the window min so the compact onboarding size isn't clamped by
        // the launcher's configured 800×600 minimum (tauri.conf.json). Restored
        // on exit — the project/picker windows keep their own minimum.
        await win.setMinSize(new LogicalSize(ONBOARDING_W, ONBOARDING_H))
        await win.setSize(new LogicalSize(ONBOARDING_W, ONBOARDING_H))
        await win.center()
      } catch {
        // Non-Tauri / unsupported — leave the window as-is.
      }
    })()
    return () => {
      void (async () => {
        try {
          // Restore the launcher's configured minimum (tauri.conf.json main window).
          await win.setMinSize(new LogicalSize(800, 600))
          if (prev) await win.setSize(prev)
        } catch {
          // ignore — window may already be gone.
        }
      })()
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

  // Finish: open the project window, THEN record it + mark onboarding done.
  // The order matters — openProjectWindow resolves only after the window is
  // actually created (and hides this launcher on success):
  //   • On failure we DON'T mark bootstrap complete, so onboarding stays put
  //     and the user can retry — instead of being stranded on an empty picker
  //     with onboarding already flagged done.
  //   • Marking complete only AFTER the launcher is hidden means BootGate's
  //     re-render to VaultLauncher never flashes on screen.
  // `busy` guards the async gap so a double-click can't spawn two windows.
  const openProject = useCallback(async () => {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      await openProjectWindow(chosen.path, folderName(chosen.path))
      addRecentProject(chosen.path, chosen.type)
      markBootstrapCompleted()
    } catch (err) {
      console.error('[onboarding] failed to open project window', err)
      setError("Couldn't open your vault. Please try again.")
      setBusy(false)
    }
  }, [chosen, busy, addRecentProject, markBootstrapCompleted])

  if (step === 'welcome') {
    return <WelcomePanel onGetStarted={() => setStep('connect')} />
  }
  if (step === 'connect') {
    // Google sign-in (identity). On success advance to folder; on failure stay
    // so the user can retry. "Start without an account" skips — Claude (the AI
    // engine) is connected just-in-time later, not here.
    const signIn = async () => {
      setConnectError(null)
      try {
        await connectGoogle()
        setStep('folder')
      } catch (e) {
        console.error('[onboarding] google sign-in failed', e)
        setConnectError("Couldn't sign in with Google. Please try again.")
      }
    }
    return (
      <ConnectPanel
        onContinue={() => void signIn()}
        onLater={() => setStep('folder')}
        connecting={googleConnecting}
        error={connectError}
      />
    )
  }
  if (step === 'folder') {
    return <FolderPanel onChooseFolder={() => void chooseFolder()} />
  }
  return <DonePanel onEnter={() => void openProject()} busy={busy} error={error} />
}
