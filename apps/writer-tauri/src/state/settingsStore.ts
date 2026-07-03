// User-controlled app settings persisted to localStorage.
//
// Phase 4 introduces a "vault" — the user's chosen folder where the
// app's wiki / daily / system pages live as plain markdown files.
// Vault path is a setting (user picks it, can change it later); the
// app reads/writes only inside it.
//
// Schema notes
//   - vaultPaths is an array for forward compatibility — v1 only ever
//     stores length 0 (no vault picked yet) or length 1. Future multi-
//     vault support adds entries without schema migration.
//   - activeVaultIndex points into vaultPaths. In v1 it's always 0
//     once a vault is picked.
//   - Empty vaultPaths means "no vault selected yet" — the boot flow
//     prompts the user with the picker dialog before any file I/O.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { type ChatModel, DEFAULT_CHAT_MODEL } from '@/chat/types'

/** What kind of project a folder holds. Drives the launcher label and,
 * later, which CLAUDE.md scaffold a fresh folder gets. Detected from the
 * folder contents when opening an existing folder (a `manuscript/` dir → a
 * translation project), or set explicitly when scaffolding a new one. */
export type ProjectType = 'wiki' | 'translation'

/** macOS system sound played when a background chat job finishes (file names in
 * /System/Library/Sounds). 'None' silences the completion ping. */
export type NotificationSound = 'None' | 'Glass' | 'Ping' | 'Pop' | 'Bottle' | 'Sosumi'

/** One row in the launcher's "Recent" list. Shared across all windows
 * (it's a global app preference, not per-window state), so it lives in
 * the persisted settings store. */
export interface RecentProject {
  path: string
  type: ProjectType
  /** Epoch ms of the last time this project was opened. Sort key for
   * the launcher list (most recent first). */
  lastOpened: number
}

interface SettingsState {
  /** Selected vault folders. v1 enforces length ≤ 1; future multi-
   * vault expansion appends without schema change. */
  vaultPaths: string[]
  /** Index into vaultPaths. v1 always 0 when a vault is selected. */
  activeVaultIndex: number
  /** True once the user has finished (or skipped) first-run
   * onboarding. Persisted to localStorage so onboarding only
   * appears once per browser profile. */
  bootstrapCompleted: boolean

  /** Replace the active vault path. v1 normalises to single-entry
   * array (legacy entries get overwritten, not appended). */
  setActiveVaultPath: (path: string) => void
  /** Clear the active vault — used when the user explicitly resets
   * or when boot detects the saved path no longer exists. */
  clearVault: () => void
  /** Flip bootstrapCompleted to true. Called by onboarding on
   * Finish / Skip. Idempotent. */
  markBootstrapCompleted: () => void

  /** Projects shown in the launcher's "Recent" list, newest first.
   * Global (cross-window) app preference. */
  recentProjects: RecentProject[]
  /** Record a project as just-opened: upsert by path (refresh its
   * `lastOpened` + type) and move it to the front. */
  addRecentProject: (path: string, type: ProjectType) => void
  /** Drop a project from the recent list (e.g. user removes a stale
   * entry whose folder is gone). */
  removeRecentProject: (path: string) => void

  /** Folder new chat-created notes land in (Obsidian's "default location for
   * new notes"). Default 'inbox'. The host FORCES this folder — the LLM's
   * chosen path is ignored — so the model can't scatter notes into wiki/ on a
   * whim. User-changeable (settings modal). */
  defaultNoteFolder: string
  /** Set the default new-note folder. Trims slashes; empty → 'inbox'. */
  setDefaultNoteFolder: (folder: string) => void

  /** Model the Organize / intake agent runs on (filing notes into the
   * wiki / daily). Default Sonnet; switch to Haiku to cut cost on bulk
   * passes, or Opus for quality. User-changeable (settings modal). */
  intakeModel: ChatModel
  /** Set the Organize / intake model. */
  setIntakeModel: (model: ChatModel) => void

  /** Auto-run the inbox Organize pass when the user goes idle (~1 min of no
   * input). Same job as the manual Organize button, but inbox-only and gated:
   * only fires when there are unprocessed captures, so an empty inbox costs
   * nothing. Default on. User-changeable (settings modal). */
  inboxAutoOrganize: boolean
  /** Toggle idle auto-organize of the inbox. */
  setInboxAutoOrganize: (enabled: boolean) => void

  /** macOS sidebar vibrancy (frosted glass). Default on. When off, the window
   * canvas + sidebar paint opaque instead of letting the native effect show.
   * Applied by useVibrancy(); macOS-only (no-op elsewhere). */
  sidebarVibrancyEnabled: boolean
  /** Toggle sidebar vibrancy. */
  setSidebarVibrancy: (enabled: boolean) => void

  /** Use the experimental CodeMirror editor instead of Milkdown. Default off
   * (Milkdown). Read by Page.tsx to pick the editor; a change takes effect on
   * the next reload. Dogfooding gate while the ProseMirror→CodeMirror
   * migration is evaluated — global (cross-window) preference. */
  cmEditorEnabled: boolean
  /** Toggle the CodeMirror editor. */
  setCmEditorEnabled: (enabled: boolean) => void

  /** Max width (px) of the CodeMirror editor's centered text column. Tuning
   * knob in Settings → Editor; applied live (no reload). */
  editorColumnWidth: number
  /** Set the editor column width in px. */
  setEditorColumnWidth: (px: number) => void

  /** CodeMirror editor body alignment. 'justify' flushes both edges (with
   * hyphenation); 'left' is ragged-right (no auto-hyphens). Applied live. */
  editorTextAlign: 'justify' | 'left'
  /** Set the editor body alignment. */
  setEditorTextAlign: (align: 'justify' | 'left') => void

  /** Sound for the background-job completion notification. 'None' = silent. */
  notificationSound: NotificationSound
  /** Set the completion-notification sound. */
  setNotificationSound: (sound: NotificationSound) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      vaultPaths: [],
      activeVaultIndex: 0,
      bootstrapCompleted: false,
      defaultNoteFolder: 'inbox',
      intakeModel: DEFAULT_CHAT_MODEL,
      inboxAutoOrganize: true,
      sidebarVibrancyEnabled: true,
      // CodeMirror is the default editor; Milkdown is the legacy fallback,
      // reachable by toggling this off in Settings → Editor (kept for rollback
      // until the PM dependency removal lands). Existing users keep their
      // persisted choice.
      cmEditorEnabled: true,
      editorColumnWidth: 700,
      editorTextAlign: 'justify',
      notificationSound: 'Glass',
      setNotificationSound: (sound) => set({ notificationSound: sound }),
      recentProjects: [],
      setActiveVaultPath: (path) =>
        set({ vaultPaths: [path], activeVaultIndex: 0 }),
      clearVault: () => set({ vaultPaths: [], activeVaultIndex: 0 }),
      markBootstrapCompleted: () => set({ bootstrapCompleted: true }),
      addRecentProject: (path, type) =>
        set((s) => ({
          recentProjects: [
            { path, type, lastOpened: Date.now() },
            ...s.recentProjects.filter((p) => p.path !== path),
          ],
        })),
      removeRecentProject: (path) =>
        set((s) => ({
          recentProjects: s.recentProjects.filter((p) => p.path !== path),
        })),
      setDefaultNoteFolder: (folder) =>
        set({ defaultNoteFolder: folder.trim().replace(/^\/+|\/+$/g, '') || 'inbox' }),
      setIntakeModel: (model) => set({ intakeModel: model }),
      setInboxAutoOrganize: (enabled) => set({ inboxAutoOrganize: enabled }),
      setSidebarVibrancy: (enabled) => set({ sidebarVibrancyEnabled: enabled }),
      setCmEditorEnabled: (enabled) => set({ cmEditorEnabled: enabled }),
      setEditorColumnWidth: (px) => set({ editorColumnWidth: px }),
      setEditorTextAlign: (align) => set({ editorTextAlign: align }),
    }),
    {
      name: 'writer-tauri:settings',
      version: 1,
      partialize: (s) => ({
        vaultPaths: s.vaultPaths,
        activeVaultIndex: s.activeVaultIndex,
        bootstrapCompleted: s.bootstrapCompleted,
        defaultNoteFolder: s.defaultNoteFolder,
        intakeModel: s.intakeModel,
        inboxAutoOrganize: s.inboxAutoOrganize,
        sidebarVibrancyEnabled: s.sidebarVibrancyEnabled,
        cmEditorEnabled: s.cmEditorEnabled,
        editorColumnWidth: s.editorColumnWidth,
        editorTextAlign: s.editorTextAlign,
        recentProjects: s.recentProjects,
      }),
    },
  ),
)

/** Read the active vault path. In a project window (window-per-project
 * model) the root is fixed by the window's `?root=` param, so it wins —
 * each window stays bound to its own folder regardless of the shared,
 * cross-window localStorage settings. Falls back to the legacy
 * single-vault store for the launcher window and the pre-multi-window
 * flow. Returns null when no vault is selected — callers gate file I/O
 * on this. */
export function getActiveVaultPath(): string | null {
  if (WINDOW_ROOT) return WINDOW_ROOT
  const { vaultPaths, activeVaultIndex } = useSettingsStore.getState()
  return vaultPaths[activeVaultIndex] ?? null
}

/** Folder new chat-created notes land in. Default 'inbox'. Non-React read for the
 * chat materialiser (toPendingChange). */
export function getDefaultNoteFolder(): string {
  return useSettingsStore.getState().defaultNoteFolder || 'inbox'
}

/** Model the Organize / intake agent runs on. Non-React read for runIntake. */
export function getIntakeModel(): ChatModel {
  return useSettingsStore.getState().intakeModel
}

/** Whether idle auto-organize of the inbox is enabled. Non-React read for the
 * idle trigger. */
export function getInboxAutoOrganize(): boolean {
  return useSettingsStore.getState().inboxAutoOrganize
}
