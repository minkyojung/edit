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

/** macOS system sound played when a background chat job finishes (file names in
 * /System/Library/Sounds). 'None' silences the completion ping. */
export type NotificationSound = 'None' | 'Glass' | 'Ping' | 'Pop' | 'Bottle' | 'Sosumi'

/** One row in the launcher's "Recent" list. Shared across all windows
 * (it's a global app preference, not per-window state), so it lives in
 * the persisted settings store. */
export interface RecentProject {
  path: string
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

  /** App version whose "What's new" note the user has already seen. When
   * the running version differs (i.e. an update landed), the What's-new
   * panel shows that version's changelog once, then this advances. Empty
   * on a fresh install (set silently on first run — no panel). */
  lastWhatsNewVersion: string
  /** Record the version whose release notes have been shown. */
  setLastWhatsNewVersion: (version: string) => void

  /** Projects shown in the launcher's "Recent" list, newest first.
   * Global (cross-window) app preference. */
  recentProjects: RecentProject[]
  /** Record a project as just-opened: upsert by path (refresh its
   * `lastOpened`) and move it to the front. */
  addRecentProject: (path: string) => void
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

  /** Folder the agent files synthesized knowledge into — the "knowledge base"
   * role bound to a concrete folder. Default 'wiki'. Injected into the prompt
   * each turn (like the capture folder) so the model routes durable knowledge
   * here, and used by the index/timeline to label + top-sort that section.
   * User-changeable (settings modal); changing it takes effect next turn. */
  knowledgeBaseFolder: string
  /** Set the knowledge-base folder. Trims slashes; empty → 'wiki'. */
  setKnowledgeBaseFolder: (folder: string) => void

  /** Folder holding user-authored templates (Obsidian's "Template folder
   * location"). Default 'templates'. Its `.md` files feed the editor slash
   * menu and the command-palette "New from template" group. A folder that
   * doesn't exist simply yields zero templates. User-changeable (settings
   * modal). */
  templatesFolder: string
  /** Set the templates folder. Trims slashes; empty string = none configured. */
  setTemplatesFolder: (folder: string) => void

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

  /** CodeMirror editor body alignment. 'justify' flushes both edges (with
   * hyphenation); 'left' is ragged-right (no auto-hyphens). Applied live. */
  editorTextAlign: 'justify' | 'left'
  /** Set the editor body alignment. */
  setEditorTextAlign: (align: 'justify' | 'left') => void

  /** Sound for the background-job completion notification. 'None' = silent. */
  notificationSound: NotificationSound
  /** Set the completion-notification sound. */
  setNotificationSound: (sound: NotificationSound) => void

  /** Security lockdown: block the AI from sending data to the network and
   * from reading secret files (SSH keys, tokens, credentials). Makes a
   * prompt injection in captured content harmless. Default ON (secure by
   * default); turning it off is an advanced choice. */
  sandboxEnabled: boolean
  /** Toggle the security lockdown. */
  setSandboxEnabled: (enabled: boolean) => void

  /** Persistent-query path: keep one long-lived SDK query per conversation so
   * background subagent tasks survive across turns (instead of being killed at
   * turn end). Default ON (graduated from dark launch in store v2); the Settings
   * toggle is the opt-out that falls back to the legacy per-turn path. */
  persistentQueryEnabled: boolean
  setPersistentQueryEnabled: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      vaultPaths: [],
      activeVaultIndex: 0,
      bootstrapCompleted: false,
      lastWhatsNewVersion: '',
      defaultNoteFolder: 'inbox',
      knowledgeBaseFolder: 'wiki',
      // Empty = no templates folder configured yet. We deliberately do NOT
      // default to a concrete name like 'templates' — that would claim a folder
      // that may not exist. The user points this at a real folder in Settings.
      templatesFolder: '',
      intakeModel: DEFAULT_CHAT_MODEL,
      inboxAutoOrganize: true,
      sidebarVibrancyEnabled: true,
      editorTextAlign: 'justify',
      notificationSound: 'Glass',
      sandboxEnabled: true,
      persistentQueryEnabled: true,
      setNotificationSound: (sound) => set({ notificationSound: sound }),
      setSandboxEnabled: (enabled) => set({ sandboxEnabled: enabled }),
      setPersistentQueryEnabled: (enabled) => set({ persistentQueryEnabled: enabled }),
      recentProjects: [],
      setActiveVaultPath: (path) =>
        set({ vaultPaths: [path], activeVaultIndex: 0 }),
      clearVault: () => set({ vaultPaths: [], activeVaultIndex: 0 }),
      markBootstrapCompleted: () => set({ bootstrapCompleted: true }),
      setLastWhatsNewVersion: (version) => set({ lastWhatsNewVersion: version }),
      addRecentProject: (path) =>
        set((s) => ({
          recentProjects: [
            { path, lastOpened: Date.now() },
            ...s.recentProjects.filter((p) => p.path !== path),
          ],
        })),
      removeRecentProject: (path) =>
        set((s) => ({
          recentProjects: s.recentProjects.filter((p) => p.path !== path),
        })),
      setDefaultNoteFolder: (folder) =>
        set({ defaultNoteFolder: folder.trim().replace(/^\/+|\/+$/g, '') || 'inbox' }),
      setKnowledgeBaseFolder: (folder) =>
        set({ knowledgeBaseFolder: folder.trim().replace(/^\/+|\/+$/g, '') || 'wiki' }),
      setTemplatesFolder: (folder) =>
        set({ templatesFolder: folder.trim().replace(/^\/+|\/+$/g, '') }),
      setIntakeModel: (model) => set({ intakeModel: model }),
      setInboxAutoOrganize: (enabled) => set({ inboxAutoOrganize: enabled }),
      setSidebarVibrancy: (enabled) => set({ sidebarVibrancyEnabled: enabled }),
      setEditorTextAlign: (align) => set({ editorTextAlign: align }),
    }),
    {
      name: 'writer-tauri:settings',
      version: 2,
      // v2: persistent-query graduated from dark-launch (default off) to default
      // on. Existing users carry a persisted `false` from the beta, which would
      // otherwise pin them to the retired legacy per-turn path forever. Move them
      // onto the new default; the Settings toggle remains as the opt-out. Only
      // touches this one flag — every other persisted field passes through.
      migrate: (persisted, version) => {
        const prev = (persisted ?? {}) as Partial<SettingsState>
        if (version < 2) return { ...prev, persistentQueryEnabled: true } as SettingsState
        return prev as SettingsState
      },
      partialize: (s) => ({
        vaultPaths: s.vaultPaths,
        activeVaultIndex: s.activeVaultIndex,
        bootstrapCompleted: s.bootstrapCompleted,
        lastWhatsNewVersion: s.lastWhatsNewVersion,
        defaultNoteFolder: s.defaultNoteFolder,
        knowledgeBaseFolder: s.knowledgeBaseFolder,
        templatesFolder: s.templatesFolder,
        intakeModel: s.intakeModel,
        inboxAutoOrganize: s.inboxAutoOrganize,
        sidebarVibrancyEnabled: s.sidebarVibrancyEnabled,
        editorTextAlign: s.editorTextAlign,
        sandboxEnabled: s.sandboxEnabled,
        persistentQueryEnabled: s.persistentQueryEnabled,
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

/** Folder the agent files synthesized knowledge into. Default 'wiki'. Non-React
 * read for the prompt assembler (chat/index.ts) and the index/timeline builders. */
export function getKnowledgeBaseFolder(): string {
  return useSettingsStore.getState().knowledgeBaseFolder || 'wiki'
}

/** Folder holding user-authored templates, or '' when none is configured.
 * Non-React read for the template loader (lib/templates). */
export function getTemplatesFolder(): string {
  return useSettingsStore.getState().templatesFolder
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

/** Whether the security lockdown (block network egress + secret-file reads)
 * is enabled. Non-React read for the chat runner, which forwards it to the
 * sidecar's `sandboxEnabled`. Default ON. */
export function getSandboxEnabled(): boolean {
  return useSettingsStore.getState().sandboxEnabled
}

/** Whether the persistent-query path is enabled. Non-React read for the chat
 * runner, which forwards it to the sidecar's `persistentQuery`. Default ON. */
export function getPersistentQueryEnabled(): boolean {
  return useSettingsStore.getState().persistentQueryEnabled
}
