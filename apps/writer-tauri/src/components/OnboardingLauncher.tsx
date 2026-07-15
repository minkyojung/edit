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
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { readDir } from '@tauri-apps/plugin-fs'
import { toast } from 'sonner'
import { pickVault } from '@/lib/vaultPicker'
import { isTranslationProject } from '@/lib/translationProject'
import { openProjectWindow, folderName } from '@/lib/projectWindow'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useSettingsStore, type ProjectType } from '@/state/settingsStore'
import { StepDots } from '@/profile/ui/onboarding/StepDots'
import { WelcomePanel } from '@/profile/ui/onboarding/WelcomePanel'
import { ConnectPanel } from '@/profile/ui/onboarding/ConnectPanel'
import { ClaudeConnectPanel } from '@/profile/ui/onboarding/ClaudeConnectPanel'
import { FolderPanel } from '@/profile/ui/onboarding/FolderPanel'
import { RolesPanel } from '@/profile/ui/onboarding/RolesPanel'
import { DonePanel } from '@/profile/ui/onboarding/DonePanel'
import {
  folderOptions,
  DEFAULT_CAPTURE,
  DEFAULT_KNOWLEDGE_BASE,
} from '@/profile/ui/onboarding/roleFolders'
import { ONBOARDING_W, ONBOARDING_H } from '@/profile/ui/onboarding/onboardingWindow'

type Step = 'welcome' | 'connect' | 'claude' | 'folder' | 'roles' | 'done'

export function OnboardingLauncher() {
  const addRecentProject = useSettingsStore((s) => s.addRecentProject)
  const markBootstrapCompleted = useSettingsStore((s) => s.markBootstrapCompleted)
  const setKnowledgeBaseFolder = useSettingsStore((s) => s.setKnowledgeBaseFolder)
  const setDefaultNoteFolder = useSettingsStore((s) => s.setDefaultNoteFolder)

  const { connect: connectGoogle, connecting: googleConnecting } = useGoogleAuth()

  const [step, setStep] = useState<Step>('welcome')
  const [chosen, setChosen] = useState<{ path: string; type: ProjectType } | null>(null)
  // Role-step state: the folder options read off the picked vault, plus the
  // user's current pick for each role (defaulted, editable in the dropdowns).
  const [roleOptions, setRoleOptions] = useState<string[]>([])
  const [knowledgeBase, setKnowledgeBase] = useState(DEFAULT_KNOWLEDGE_BASE)
  const [capture, setCapture] = useState(DEFAULT_CAPTURE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

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

  // Remember a chosen folder + advance. Shared by the native picker and folder
  // drag-and-drop. Detecting an existing translation project keeps that path
  // working even though onboarding no longer scaffolds.
  //
  // For a wiki vault, scan its top-level folders and go to the roles step so
  // the user maps knowledge base + capture to real folders. Translation
  // projects use a fixed manuscript/reference layout — the roles don't apply,
  // so they skip straight to done.
  const acceptFolder = useCallback(async (path: string) => {
    const type: ProjectType = (await isTranslationProject(path)) ? 'translation' : 'wiki'
    setChosen({ path, type })
    if (type === 'translation') {
      setStep('done')
      return
    }
    let dirs: string[] = []
    try {
      const entries = await readDir(path)
      dirs = entries.filter((e) => e.isDirectory).map((e) => e.name)
    } catch {
      // Unreadable folder — fall back to just the role defaults.
    }
    setRoleOptions(folderOptions(dirs))
    setStep('roles')
  }, [])

  // Save the role → folder mapping to settings (read every turn by the agent
  // and by the index/timeline), then finish. Empty vault: the chosen folders
  // come into existence on first write.
  const confirmRoles = useCallback(() => {
    setKnowledgeBaseFolder(knowledgeBase)
    setDefaultNoteFolder(capture)
    setStep('done')
  }, [knowledgeBase, capture, setKnowledgeBaseFolder, setDefaultNoteFolder])

  // Mandatory folder choice via the native picker. Its "New Folder" affordance
  // covers the create case.
  const chooseFolder = useCallback(async () => {
    const path = await pickVault()
    if (path) await acceptFolder(path)
  }, [acceptFolder])

  // Accept a folder dropped from Finder. readDir throws on a file / no access,
  // so it doubles as a "is this a usable folder?" check.
  const handleDroppedFolder = useCallback(
    async (path: string) => {
      try {
        await readDir(path)
      } catch {
        toast.error('Please drop a folder', {
          description: 'Drop a folder of notes, not a file.',
        })
        return
      }
      await acceptFolder(path)
    },
    [acceptFolder],
  )

  // Wire native folder drag-and-drop while the folder step is on screen. Tauri's
  // drag-drop handler (dragDropEnabled) gives real paths; the HTML5 drop can't.
  useEffect(() => {
    if (step !== 'folder') return
    let alive = true
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter' || p.type === 'over') setDragActive(true)
        else if (p.type === 'leave') setDragActive(false)
        else if (p.type === 'drop') {
          setDragActive(false)
          const first = p.paths[0]
          if (first) void handleDroppedFolder(first)
        }
      })
      .then((u) => {
        if (alive) unlisten = u
        else u()
      })
    return () => {
      alive = false
      unlisten?.()
      setDragActive(false)
    }
  }, [step, handleDroppedFolder])

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

  const dots = <StepDots step={step} />

  const panel = (() => {
    if (step === 'welcome') {
      return <WelcomePanel onGetStarted={() => setStep('connect')} progress={dots} />
    }
    if (step === 'connect') {
      // Google sign-in (identity). On success advance to folder; on failure stay
      // so the user can retry. "Start without an account" skips — Claude (the AI
      // engine) is connected just-in-time later, not here.
      const signIn = async () => {
        setConnectError(null)
        try {
          await connectGoogle()
          // Fire the sign-up relay (welcome email) — best-effort, never blocks
          // the flow. Onboarding-only, so a settings reconnect won't re-welcome.
          void invoke('notify_signup').catch((e) =>
            console.warn('[onboarding] signup relay failed', e),
          )
          setStep('claude')
        } catch (e) {
          console.error('[onboarding] google sign-in failed', e)
          setConnectError("Couldn't sign in with Google. Please try again.")
        }
      }
      return (
        <ConnectPanel
          onContinue={() => void signIn()}
          onLater={() => setStep('claude')}
          connecting={googleConnecting}
          error={connectError}
          progress={dots}
        />
      )
    }
    if (step === 'claude') {
      // Connect Claude (the AI engine) via the existing OAuth commands — browser
      // authorize + paste the code (same backend as ConnectClaudeDialog / oauth.rs).
      // Skippable; the chat panel re-prompts sign-in later if the user skips here.
      return (
        <ClaudeConnectPanel
          onStart={async () => {
            await invoke('start_claude_oauth')
          }}
          onSubmit={async (code) => {
            await invoke('complete_claude_oauth', { pasted: code })
            setStep('folder')
          }}
          onLater={() => setStep('folder')}
          progress={dots}
        />
      )
    }
    if (step === 'folder') {
      return (
        <FolderPanel
          onChooseFolder={() => void chooseFolder()}
          dragActive={dragActive}
          progress={dots}
        />
      )
    }
    if (step === 'roles') {
      return (
        <RolesPanel
          options={roleOptions}
          knowledgeBase={knowledgeBase}
          capture={capture}
          onKnowledgeBaseChange={setKnowledgeBase}
          onCaptureChange={setCapture}
          onContinue={confirmRoles}
          progress={dots}
        />
      )
    }
    return (
      <DonePanel
        onEnter={() => void openProject()}
        vaultName={chosen ? folderName(chosen.path) : undefined}
        busy={busy}
        error={error}
      />
    )
  })()

  return panel
}
