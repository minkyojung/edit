import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { AppToaster } from '@/components/AppToaster'
import { BootGate } from '@/components/BootGate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FullPageErrorFallback } from '@/components/ErrorFallback'
import { MarkPopoverLayer } from '@/components/agent/MarkPopoverLayer'
import { MarkHoverActionsLayer } from '@/components/agent/MarkHoverActionsLayer'
import { AppShell } from '@/layout/AppShell'
import { Page } from '@/layout/Page'
import { CommandPalette } from '@/layout/CommandPalette'
import { WikiPageBanner } from '@/layout/WikiPageBanner'
import { OnboardingDialog } from '@/profile/ui/OnboardingDialog'
import { ImageAltDialog } from '@/editor/ImageAltDialog'
import { useDocsStore } from '@/state/docsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { useIdleTrigger } from '@/hooks/useIdleTrigger'
import { useRouteSync } from '@/hooks/useRouteSync'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildViewUrl, parseSlugFromPath } from '@/lib/viewUrl'
import {
  useLazyMaterialize,
  type LazyMaterializeConfig,
} from '@/hooks/useLazyMaterialize'
import { useMigrateLegacyIngestMarks } from '@/hooks/useMigrateLegacyIngestMarks'
import { applyPendingLogsForView } from '@/agent/applyIngest'
// Phase 4.A — dev-only side-effect imports. Each module registers
// a `window.__X` handle so the picker / vault I/O is reachable from
// DevTools before real UI wiring lands. Real callers (settings
// panel, boot-time prompt, file watcher) will import these for
// their actual API and the dev handles fall away.
import '@/lib/vaultPicker'
import '@/lib/vault'
import '@/lib/scanVault'
import { initHeadlessParser } from '@/lib/headlessMilkdown'
import { startAutoFlush } from '@/lib/docFileSync'
import { startVaultWatcher } from '@/lib/vaultWatcher'

// Path C Step 3c — boot the headless Milkdown so parser / serializer
// land in editorViewStore before any doc-loading code runs. Without
// this, applyVaultToHandle (called from buildHandle's contentReady)
// would race the per-doc MilkdownEditor mount and silently fall back
// to 'no-parser', leaving the body empty on every fresh open.
void initHeadlessParser()

// Begin the periodic vault flush loop on app load. Idempotent: safe
// under React StrictMode's double-mount and against any future caller
// that might also start it.
startAutoFlush()

// Watch the vault folder for external edits. Gated on
// getActiveVaultPath() inside startVaultWatcher — when BootGate's
// auto-picker is still up, it logs an inert message and no-ops.
// The picker re-invokes after selecting a vault.
void startVaultWatcher()

// Module-scope so the configs array reference is stable across
// renders — required by useLazyMaterialize's caller contract
// (configs.length must be constant; React enforces it for the
// per-config hook calls inside).
const SYSTEM_DRAIN_CONFIGS: LazyMaterializeConfig[] = [
  {
    matchType: 'system:log',
    queueSelector: (s) => s.pendingLogs,
    applyForView: applyPendingLogsForView,
    signaturePrefix: 'log',
  },
  // system:index used to live here too — it now writes deterministically
  // from state/wikiIndex.ts on every wiki change, no queue needed.
]

export function App() {
  // HashRouter sits above BootGate so anything router-aware (useActiveSlug,
  // useNavigate, useLocation) can be called from anywhere inside the app
  // — including AppContent itself. BootGate is router-agnostic; it only
  // gates rendering on the catalog bootstrap, so hoisting the router
  // above it doesn't change any timing.
  return (
    <ThemeProvider defaultPalette="charcoal" storageKey="writer-palette">
      <TooltipProvider delayDuration={200}>
        <HashRouter>
          <BootGate>
            <AppContent />
          </BootGate>
          <AppToaster />
        </HashRouter>
      </TooltipProvider>
    </ThemeProvider>
  )
}

// Renders nothing — exists solely to host useRouteSync inside the
// HashRouter, where useLocation can read the current pathname. Kept
// at the top of the router's child tree so the store catches the
// URL on the same tick the route renders (no flash of stale state
// in the sidebar/editor on first paint).
//
// Also responsible for the post-bootstrap URL backfill: bootstrap
// picks a boot-target slug (last open doc, or today's daily) and
// stashes it on `bootTargetSlug`. If the user entered on a URL
// without a slug (`/`, `/day/<date>`, etc.), we replace into the
// full URL with the boot target so the back/forward stack starts
// clean and the editor has a doc to render. Replace (not push) so
// the very first ⌘[ doesn't bounce back into a slug-less limbo.
function RouteSyncBridge() {
  useRouteSync()

  const bootstrapping = useDocsStore((s) => s.bootstrapping)
  const bootTargetSlug = useDocsStore((s) => s.bootTargetSlug)
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const clearBootTarget = useDocsStore((s) => s.clearBootTarget)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    if (bootstrapping) return
    if (!bootTargetSlug) return
    // URL already names a slug → user entered via deep link or
    // refresh. Respect what they typed; just clear the unused
    // bootTargetSlug so future boots don't reuse it.
    if (parseSlugFromPath(pathname) !== null) {
      clearBootTarget()
      return
    }
    navigate(
      buildViewUrl({
        tab: sidebarTab,
        dayAnchor,
        monthAnchor,
        slug: bootTargetSlug,
      }),
      { replace: true },
    )
    clearBootTarget()
  }, [
    bootstrapping,
    bootTargetSlug,
    sidebarTab,
    dayAnchor,
    monthAnchor,
    pathname,
    navigate,
    clearBootTarget,
  ])

  return null
}

// Everything inside BootGate — by the time this renders, the catalog
// bootstrap has finished, so React subscriptions land on a stable
// store and the sidebar's first paint reflects the user's real data.
function AppContent() {
  const activeSlug = useActiveSlug()
  const handles = useDocsStore((s) => s.handles)
  const statusMap = useDocsStore((s) => s.status)
  const [view, setView] = useState<EditorView | null>(null)

  // Karpathy "Memories" ingest — fires in the background when the
  // user navigates away from a daily, or when the local date rolls
  // over. Mounted once here at the root so subscriptions and the
  // date-poll timer share a single lifetime across the session.
  useIdleTrigger()
  // Drains queued log entries / index updates into their respective
  // system pages when the user navigates there. One hook, one
  // configs table — adding system:about or system:lint later is a
  // single config row above. Wiki proposal review (the third
  // ingest output) stays on the in-page banner surface, not in
  // this lazy-drain pipeline.
  useLazyMaterialize(SYSTEM_DRAIN_CONFIGS)
  // One-time cleanup of legacy ingest-origin proofSuggestion marks
  // left over from the pre-banner era. Runs per wiki page on first
  // mount post-upgrade; no-op afterwards.
  useMigrateLegacyIngestMarks()

  // First-run onboarding trigger. We read bootstrapCompleted from the
  // persisted settings store as the initial value so a returning user
  // never sees a flash of the dialog. The state is local — once
  // OnboardingDialog calls markBootstrapCompleted, this component
  // doesn't need to know; the next launch starts with the flag true.
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => !useSettingsStore.getState().bootstrapCompleted,
  )

  const activeHandle = activeSlug ? handles[activeSlug] ?? null : null
  const activeStatus = activeSlug ? statusMap[activeSlug] ?? 'loading' : 'loading'

  // The notes shell is identical across every Day/Week/Month route —
  // the URL only changes which sidebar view / anchor / open slug the
  // store reflects. Hoisting the element keeps the <Routes> table a
  // pure mapping from path → same surface, so adding a new view
  // route later is a one-line addition rather than a copy of the JSX.
  const notesElement = (
    <>
      {/* Banner mounts above the editor and self-hides
          when the active doc isn't a wiki:* page with
          pending proposals. Lives in the scroll area
          so it doesn't shift layout when it appears/
          disappears. */}
      <WikiPageBanner />
      <Page
        key={activeSlug ?? 'no-doc'}
        handle={activeHandle}
        status={activeStatus}
        onViewReady={(v) => {
          // Mirror into the global store so non-React
          // consumers (banner accept, future palette
          // commands) can reach the live view without
          // prop drilling. Local state stays the source
          // of truth for sibling renders below.
          setView(v)
          useEditorViewStore.getState().setView(v)
        }}
      />
    </>
  )

  return (
    <ErrorBoundary
      FallbackComponent={FullPageErrorFallback}
      onError={(error, info) => console.error('[app] uncaught render error', error, info)}
    >
      <>
        <RouteSyncBridge />
        <AppShell
          oauthStatus="unauthenticated"
          collabHandle={activeHandle}
          collabStatus={activeStatus}
          editorView={view}
        >
          <Routes>
            {/* Root + legacy /notes both redirect to today's Day view.
                todayLocalDate() is called on each render so a session
                that crosses midnight still resolves to the right day
                on first navigation. /notes survives as a legacy
                deep-link target only — no live caller navigates here. */}
            <Route path="/" element={<Navigate to={`/day/${todayLocalDate()}`} replace />} />
            <Route path="/notes" element={<Navigate to={`/day/${todayLocalDate()}`} replace />} />
            <Route path="/day/:date" element={notesElement} />
            <Route path="/day/:date/:slug" element={notesElement} />
            <Route path="/week" element={notesElement} />
            <Route path="/week/:slug" element={notesElement} />
            <Route path="/month/:ym" element={notesElement} />
            <Route path="/month/:ym/:slug" element={notesElement} />
          </Routes>
        </AppShell>
        <MarkHoverActionsLayer editorView={view} ydoc={activeHandle?.ydoc ?? null} />
        <MarkPopoverLayer editorView={view} ydoc={activeHandle?.ydoc ?? null} />
        <CommandPalette />
        <OnboardingDialog
          open={onboardingOpen}
          onClose={() => setOnboardingOpen(false)}
        />
        <ImageAltDialog />
      </>
    </ErrorBoundary>
  )
}
