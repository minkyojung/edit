// Blocks the app UI until docsStore.bootstrap() finishes.
//
// What bootstrap() does, and why we wait for it before any UI
// renders:
//
//   1. Migrate the legacy single-slug localStorage entry into a
//      catalog-shaped daily so existing content survives the
//      multi-doc rewrite.
//   2. Ensure today's daily exists in the catalog (creating it if
//      missing).
//   3. Wire the active slug + open its collab handle.
//
// Until those land, knownDocs is empty or half-populated and the
// sidebar shows a stale shape — a user clicking "New Note" mid-
// boot could race the migration and create a doc the legacy
// adopter then duplicates. The gate sidesteps the race by simply
// not rendering the action surface until bootstrapping flips.
//
// Background backfill (the current week's dailies, future schema
// migrations that aren't blocking) deliberately fires AFTER the
// flag flips, so the user sees the app open as soon as their
// today-anchor is ready — the rest streams in.
//
import { useEffect, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { useDocsStore } from '@/state/docsStore'
import { useThreadsStore } from '@/state/threadsStore'
import { useVaultCommands } from '@/state/vaultCommandsStore'
import { getActiveVaultPath, useSettingsStore } from '@/state/settingsStore'
import { WINDOW_ROOT } from '@/lib/windowRoot'
import { VaultLauncher } from '@/components/VaultLauncher'
import { OnboardingLauncher } from '@/components/OnboardingLauncher'
import { resolveWindowMode } from '@/hooks/useWindowModeSync'
import { exists } from '@tauri-apps/plugin-fs'
import { seedClaudeMd, seedWelcomeNote, seedFirstDaily } from '@/lib/seedClaudeMd'
import { seedRoutines } from '@/lib/routinesLib'
import { seedAgents } from '@/lib/agentsLib'
import { seedSkills } from '@/lib/skillsLib'
import { DEFAULT_SKILLS, DEFAULT_COMMANDS, DEFAULT_AGENTS } from '@/agent/defaults'
import { isTranslationProject } from '@/lib/translationProject'
import { gitInit } from '@/lib/git'

const LOADER_DELAY_MS = 400 // keep spinner flashes off fast boots

/** Wiki-vault boot steps: seed the default files a wiki vault needs (CLAUDE.md,
 * routine commands, agent roles). Only wiki vaults get these — a translation
 * project (a folder with `manuscript/`) has its own layout and would just get
 * littered with wiki scaffolding. Each step is best-effort: a failure logs and
 * the boot continues. */
async function seedWikiDefaults(): Promise<void> {
  // Seed a `Welcome.md` starter note into a BRAND-NEW vault (detected by the
  // absence of CLAUDE.md), so a first-run user opens on real content instead of
  // a blank editor. MUST run before seedClaudeMd — the freshness check reads
  // CLAUDE.md's absence. No-op on existing vaults.
  try {
    await seedWelcomeNote()
  } catch (err) {
    console.warn('[boot] Welcome.md seed failed', err)
  }
  // Seed today's daily with a personal welcome (fresh vaults only, before
  // seedClaudeMd — same CLAUDE.md-absence freshness gate). Gives the
  // timeline a first entry instead of an empty axis.
  try {
    await seedFirstDaily()
  } catch (err) {
    console.warn('[boot] first daily seed failed', err)
  }
  // Seed `CLAUDE.md` at the vault root if missing — the schema document the
  // agent reads every chat. Idempotent by file existence; never overwrites
  // a user's edits.
  try {
    await seedClaudeMd()
  } catch (err) {
    console.warn('[boot] CLAUDE.md seed failed', err)
  }
  // Seed default routine command files (`.claude/commands/*.md`) — the editable
  // task brains. Idempotent by file existence; never overwrites the user's edits.
  try {
    await seedRoutines(DEFAULT_COMMANDS)
  } catch (err) {
    console.warn('[boot] routines seed failed', err)
  }
  // Load the seeded routine commands into the slash palette (organize /
  // daily-ingest / chat-to-wiki + any the user added). Best-effort.
  await useVaultCommands.getState().refresh()
  // Seed the default agent role (`_system/agent/agents/default.md`) — the
  // editable chat persona (from FREE_CHAT_PROMPT). The only role shipped by
  // default; the user can add their own.
  try {
    await seedAgents(DEFAULT_AGENTS)
  } catch (err) {
    console.warn('[boot] agents seed failed', err)
  }
  // Seed default skills (`_system/agent/skills/<name>/SKILL.md`) — procedures
  // the agent loads on demand. `undo-ai-change` lets the agent reverse its own
  // recent edits when the user regrets one. Idempotent + tombstone-aware.
  try {
    await seedSkills(DEFAULT_SKILLS)
  } catch (err) {
    console.warn('[boot] skills seed failed', err)
  }
}

interface Props {
  children: React.ReactNode
}

export function BootGate({ children }: Props) {
  const bootstrapping = useDocsStore((s) => s.bootstrapping)
  const bootstrap = useDocsStore((s) => s.bootstrap)
  const [showLoader, setShowLoader] = useState(false)
  // Window-per-project model: a window boots a vault ONLY when it carries a
  // `?root` param (a project window). A window without one is the launcher —
  // it always shows the picker and never boots, regardless of any legacy
  // single-vault path left in the shared, cross-window localStorage. The
  // launcher spawns a separate window per project; getActiveVaultPath() in a
  // project window returns its WINDOW_ROOT.
  const [hasVault, setHasVault] = useState(() => WINDOW_ROOT !== null)

  // First-run gate flag. Read reactively so that when onboarding marks it
  // completed (choose folder / skip), the launcher window re-renders from the
  // OnboardingLauncher to the normal VaultLauncher.
  const bootstrapCompleted = useSettingsStore((s) => s.bootstrapCompleted)

  // Resolve the compact/full window mode from the real window size BEFORE the
  // app UI paints, so an editor window that was compact at reload renders
  // compact from the first frame (no full→compact flash). Runs in parallel
  // with bootstrap; being one fast IPC it settles well before it.
  const [modeResolved, setModeResolved] = useState(false)
  useEffect(() => {
    void resolveWindowMode().finally(() => setModeResolved(true))
  }, [])
  // Whether the stored vault path has been verified to still exist on disk.
  // A path can be remembered across sessions but the folder later moved,
  // deleted, parked on an unmounted drive, or not-yet-synced (iCloud). We
  // must NOT boot into a missing folder: scanVault would throw and bootstrap
  // has no catch, so the app hangs on the loader forever with no way out.
  const [vaultChecked, setVaultChecked] = useState(false)

  // Verify the stored vault still exists before booting into it. If it's
  // gone, fall back to the launcher (re-pick / restore) instead of hanging.
  useEffect(() => {
    let cancelled = false
    const verify = async () => {
      const path = getActiveVaultPath()
      if (path) {
        try {
          if (!(await exists(path)) && !cancelled) setHasVault(false)
        } catch {
          // Treat an unreadable path the same as missing — route to the
          // launcher rather than letting the boot sequence stumble into it.
          if (!cancelled) setHasVault(false)
        }
      }
      if (!cancelled) setVaultChecked(true)
    }
    void verify()
    return () => {
      cancelled = true
    }
  }, [])

  // Fire bootstrap once on mount. The store's bootstrap is idempotent
  // (it short-circuits when the catalog already has today's daily),
  // but React's Strict Mode would still double-call this useEffect —
  // hence the idempotency on the store side, not a guard here.
  //
  // A vault must be selected before bootstrap so every doc it touches
  // (today's daily + system pages) can reach disk. VaultLauncher owns that
  // choice now — a local folder, or restore-from-GitHub (which MUST run before
  // anything fills the folder). This effect waits until a vault is in place.
  useEffect(() => {
    // Wait until the vault path is both present AND verified to exist on
    // disk — never start the boot sequence against a missing folder.
    if (!hasVault || !vaultChecked) return
    const init = async () => {
      // Reversibility floor: initialise the vault as a git repo (idempotent —
      // the rust side fast-paths an existing `.git`) so every AI edit becomes a
      // revertible checkpoint. Best-effort — git missing / not installed
      // degrades to "no checkpoints" (the `.md` files stay the durable source)
      // instead of blocking boot. This is LOCAL history only; GitHub
      // backup/push stays disabled. Runs for every project kind.
      try {
        await gitInit()
      } catch (err) {
        console.warn('[boot] git init failed — checkpoints disabled', err)
      }

      // Project kind drives which boot steps run. The wiki default seeds apply
      // only to wiki vaults; a translation project (a folder with `manuscript/`)
      // has its own layout, so we skip them to keep the project clean.
      // bootstrap() below is generic and runs for every kind. Unknown / fresh
      // folders default to wiki.
      const vaultRoot = getActiveVaultPath()
      const isWiki = vaultRoot ? !(await isTranslationProject(vaultRoot)) : true
      if (isWiki) {
        await seedWikiDefaults()
      }
      bootstrap()
      // Load chat thread metas + turns from `threads/`. Fires in
      // parallel with bootstrap because the two read disjoint paths
      // (docs read `wiki/` / `daily/` / `_system/`, threads read
      // `threads/`). hydrate is idempotent so StrictMode's double-
      // mount is safe.
      void useThreadsStore.getState().hydrate()
    }
    void init()
  }, [hasVault, vaultChecked, bootstrap])

  // Delay the visual loader by 400 ms so a fast bootstrap doesn't
  // produce a spinner flash.
  useEffect(() => {
    if (!bootstrapping) return
    const t = window.setTimeout(() => setShowLoader(true), LOADER_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [bootstrapping])

  const loadingView = (
    <div className="flex h-full w-full items-center justify-center bg-background">
      {showLoader && (
        <div className="flex items-center gap-2 text-footnote text-muted-foreground">
          <Spinner />
          <span>Loading your notes…</span>
        </div>
      )}
    </div>
  )

  // Still verifying the stored vault exists — hold the loader rather than
  // flashing the launcher or booting into a folder that may be missing.
  if (!vaultChecked) return loadingView

  // Launcher window (no `?root`) → project picker. It spawns a separate
  // window per project and never boots a vault itself. On the very first run
  // the onboarding owns this window BEFORE the picker: it welcomes the user
  // and folds the folder choice into its flow, then hands off to a project
  // window. Once complete (or skipped), later launches show the picker.
  if (!hasVault) {
    return bootstrapCompleted ? <VaultLauncher /> : <OnboardingLauncher />
  }

  // Hold the app UI until the window mode is known too, so it never paints
  // full-size chrome into a compact window for a frame.
  if (!bootstrapping && modeResolved) return <>{children}</>

  return loadingView
}
