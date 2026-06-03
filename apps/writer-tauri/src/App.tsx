import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from 'react-error-boundary'
import type { EditorView } from '@milkdown/kit/prose/view'
import { ThemeProvider } from '@/components/theme-provider'
import { FontProvider } from '@/components/font-provider'
import { AppToaster } from '@/components/AppToaster'
import { BootGate } from '@/components/BootGate'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FullPageErrorFallback } from '@/components/ErrorFallback'
import { AppShell } from '@/layout/AppShell'
import { Page } from '@/layout/Page'
import { ReadLaterQueue } from '@/layout/ReadLaterQueue'
import { CommandPalette } from '@/layout/CommandPalette'
import { OnboardingDialog } from '@/profile/ui/OnboardingDialog'
import { ImageAltDialog } from '@/editor/ImageAltDialog'
import { SaveArticleDialog } from '@/components/SaveArticleDialog'
import { useDocsStore } from '@/state/docsStore'
import { usePendingChangesStore } from '@/state/pendingChangesStore'
import { useSettingsStore } from '@/state/settingsStore'
import { useEditorViewStore } from '@/state/editorViewStore'
import { todayLocalDate } from '@/hooks/useDocMeta'
import { useIdleTrigger } from '@/hooks/useIdleTrigger'
import { useRouteSync } from '@/hooks/useRouteSync'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { usePersistLastPath } from '@/hooks/usePersistLastPath'
import { useWindowChrome } from '@/hooks/useWindowChrome'
import {
  buildDayUrl,
  buildMonthUrl,
  buildWeekUrl,
  parseSlugFromPath,
} from '@/lib/viewUrl'
import {
  useLazyMaterialize,
  type LazyMaterializeConfig,
} from '@/hooks/useLazyMaterialize'
import { applyPendingLogsForView } from '@/agent/applyIngest'
// Phase 4.A — dev-only side-effect imports. Each module registers
// a `window.__X` handle so the picker / vault I/O is reachable from
// DevTools before real UI wiring lands. Real callers (settings
// panel, boot-time prompt, file watcher) will import these for
// their actual API and the dev handles fall away.
import '@/lib/vaultPicker'
import '@/lib/vault'
import '@/lib/scanVault'
import '@/lib/caretDebug'
import { startAutoFlush } from '@/lib/docFileSync'
import { startVaultWatcher } from '@/lib/vaultWatcher'
import { startPendingChangesApplier } from '@/state/pendingChangesApplier'

// Begin the periodic vault flush loop on app load. Idempotent: safe
// under React StrictMode's double-mount and against any future caller
// that might also start it.
startAutoFlush()

// Watch the vault folder for external edits. Gated on
// getActiveVaultPath() inside startVaultWatcher — when BootGate's
// auto-picker is still up, it logs an inert message and no-ops.
// The picker re-invokes after selecting a vault.
void startVaultWatcher()

// Listen for `pending → accepted` transitions in pendingChangesStore
// and run the matching disk-write path. Without this no click on the
// inline Keep button changes the file on disk — the store just
// flips status and the widget vanishes. Idempotent.
startPendingChangesApplier()

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
      <FontProvider defaultFont="pretendard" storageKey="writer-font">
        <TooltipProvider delayDuration={200}>
          <HashRouter>
            <BootGate>
              <AppContent />
            </BootGate>
            <AppToaster />
          </HashRouter>
        </TooltipProvider>
      </FontProvider>
    </ThemeProvider>
  )
}

// Renders nothing — exists solely to host useRouteSync + the URL
// reconciler inside the HashRouter, where useLocation can read the
// current pathname. Kept at the top of the router's child tree so
// the store catches the URL on the same tick the route renders (no
// flash of stale state in the sidebar/editor on first paint).
//
// The reconciler enforces a single invariant on every pathname
// change (after bootstrap completes):
//
//   "the URL must name a slug that exists in knownDocs"
//
// Violations — slug-less roots, deleted docs, vault swaps — are
// repaired via a `replace` navigate to a fallback URL (today's
// daily under the URL's current view shape). This replaces the
// earlier one-shot bootTargetSlug pattern: every entry into a
// broken URL self-heals, not just the cold-boot one.
//
// Exception: first-class routes that intentionally carry NO slug (they
// render their own React surface instead of a document) must be exempt —
// otherwise the self-heal reads their null slug as "broken" and bounces
// the user back to today's daily.
const SLUGLESS_ROUTES = new Set(['/read-later'])

function RouteSyncBridge() {
  useRouteSync()
  usePersistLastPath()

  const bootstrapping = useDocsStore((s) => s.bootstrapping)
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const openSlugs = useDocsStore((s) => s.openSlugs)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    if (bootstrapping) return
    // Slug-less first-class routes (the Read Later queue) are valid
    // WITHOUT a document. Without this guard the self-heal below sees a
    // null slug, judges the URL "broken", and bounces back to today's
    // daily a beat after the queue paints.
    if (SLUGLESS_ROUTES.has(pathname)) return
    const slug = parseSlugFromPath(pathname)
    const valid = slug !== null && knownDocs.some((d) => d.slug === slug)
    if (valid) return

    // Pick a fallback slug. Today's daily is the journal floor and
    // bootstrap guarantees it exists in knownDocs; openSlugs[0] is
    // a safety net for the edge case where the day rolled over and
    // today's daily hasn't been re-ensured yet.
    const today = todayLocalDate()
    const todaysDaily = knownDocs.find(
      (d) => d.type === 'daily' && d.date === today && !d.archivedAt,
    )
    const fallbackSlug = todaysDaily?.slug ?? openSlugs[0]
    if (!fallbackSlug) return

    // Preserve the URL's current view shape — if the user is on
    // /week/<bad>, fall back to /week/<good>, not /day/<today>/<good>.
    // For roots / unknown shapes we default to today's day view.
    navigate(buildFallbackUrl(pathname, fallbackSlug), { replace: true })
  }, [bootstrapping, pathname, knownDocs, openSlugs, navigate])

  return null
}

/** Build a fallback URL that preserves the current view shape (day /
 * week / month + its anchor) and swaps in a valid slug. Falls back to
 * today's day view for roots and unknown shapes. */
function buildFallbackUrl(pathname: string, slug: string): string {
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const head = parts[0]
  if (head === 'day' && parts[1]) return buildDayUrl(parts[1], slug)
  if (head === 'week') return buildWeekUrl(slug)
  if (head === 'month' && parts[1]) return buildMonthUrl(parts[1], slug)
  return buildDayUrl(todayLocalDate(), slug)
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
  useWindowChrome()

  // Sidebar dot semantic (Phase E2.8): the dot flips to "viewed"
  // (grey) the moment the user navigates to a page that has staged
  // AI changes. This effect is the trigger — markPageViewed stamps
  // `viewedAt` on every entry targeting `activeSlug`. Idempotent;
  // re-marking already-viewed entries is a no-op inside the store.
  // Lives at the root rather than in Page.tsx so the inline review
  // plugin / editor doesn't need to know about dot lifecycle.
  useEffect(() => {
    if (!activeSlug) return
    usePendingChangesStore.getState().markPageViewed(activeSlug)
  }, [activeSlug])
  // Drains queued log entries / index updates into their respective
  // system pages when the user navigates there. One hook, one
  // configs table — adding system:about or system:lint later is a
  // single config row above. Wiki proposal review (the third
  // ingest output) stays on the in-page banner surface, not in
  // this lazy-drain pipeline.
  useLazyMaterialize(SYSTEM_DRAIN_CONFIGS)

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
    <Page
      key={activeSlug ?? 'no-doc'}
      handle={activeHandle}
      status={activeStatus}
      onViewReady={(v) => {
        // Mirror into the global store so non-React
        // consumers (future palette commands) can reach
        // the live view without prop drilling. Local
        // state stays the source of truth for sibling
        // renders below.
        setView(v)
        useEditorViewStore.getState().setView(v)
      }}
    />
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
            <Route path="/read-later" element={<ReadLaterQueue />} />
          </Routes>
        </AppShell>
        <CommandPalette />
        <OnboardingDialog
          open={onboardingOpen}
          onClose={() => setOnboardingOpen(false)}
        />
        <ImageAltDialog />
        <SaveArticleDialog />
      </>
    </ErrorBoundary>
  )
}
