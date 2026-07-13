// Design-preview page for the onboarding flow — like the gallery, but with no
// sidebar or editor. Renders each onboarding step centred inside a fixed frame
// that mimics the compact onboarding window (900×600), so the layout reads at
// true proportions. Flip through steps with Prev/Next — no app restart needed.
//
// Steps render their PRESENTATIONAL panels with no-op handlers (no window
// resize, no real folder-pick), so iterating here has zero side effects. Add a
// step to STEPS as the flow grows; it appears in the flipper automatically.
//
// Reached via the sidebar "Onboarding" entry (a standalone top-level route, so
// it paints without the app chrome). A "Back to app" button returns.

import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { WelcomePanel } from '@/profile/ui/onboarding/WelcomePanel'
import { ConnectPanel } from '@/profile/ui/onboarding/ConnectPanel'
import { ClaudeConnectPanel } from '@/profile/ui/onboarding/ClaudeConnectPanel'
import { FolderPanel } from '@/profile/ui/onboarding/FolderPanel'
import { RolesPanel } from '@/profile/ui/onboarding/RolesPanel'
import { DonePanel } from '@/profile/ui/onboarding/DonePanel'
import { Button } from '@/components/ui/button'
import { ONBOARDING_W, ONBOARDING_H } from '@/profile/ui/onboarding/onboardingWindow'
import { StepDots } from '@/profile/ui/onboarding/StepDots'

const noop = () => {}

const STEPS: { key: string; label: string; render: () => ReactNode }[] = [
  {
    key: 'welcome',
    label: 'Welcome + trust',
    render: () => <WelcomePanel onGetStarted={noop} progress={<StepDots step="welcome" />} />,
  },
  {
    key: 'connect',
    label: 'Sign in with Google',
    render: () => (
      <ConnectPanel onContinue={noop} onLater={noop} progress={<StepDots step="connect" />} />
    ),
  },
  {
    key: 'claude',
    label: 'Connect Claude',
    render: () => (
      <ClaudeConnectPanel
        onStart={async () => {}}
        onSubmit={async () => {}}
        onLater={noop}
        progress={<StepDots step="claude" />}
      />
    ),
  },
  {
    key: 'folder',
    label: 'Choose folder',
    render: () => <FolderPanel onChooseFolder={noop} progress={<StepDots step="folder" />} />,
  },
  {
    key: 'roles',
    label: 'Map folders to roles',
    render: () => (
      <RolesPanel
        options={['inbox', 'notes', 'research', 'wiki']}
        knowledgeBase="wiki"
        capture="inbox"
        onKnowledgeBaseChange={noop}
        onCaptureChange={noop}
        onContinue={noop}
        progress={<StepDots step="roles" />}
      />
    ),
  },
  {
    key: 'done',
    label: "You're all set",
    render: () => <DonePanel onEnter={noop} />,
  },
]

export function OnboardingPreview() {
  const [i, setI] = useState(0)
  const navigate = useNavigate()
  const step = STEPS[i]
  const atStart = i === 0
  const atEnd = i === STEPS.length - 1

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-6 bg-muted/40">
      {/* Frame mimicking the compact onboarding window. Corner matches the real
          window's native radius (--window-radius = the objc2 NSToolbar corner,
          ~26px on macOS Tahoe) so the preview reads at true curvature. */}
      <div
        className="overflow-hidden rounded-[var(--window-radius)] border border-border bg-background shadow-2xl"
        style={{ width: ONBOARDING_W, height: ONBOARDING_H }}
      >
        {step.render()}
      </div>

      {/* Step flipper */}
      <div className="flex items-center gap-4 text-footnote text-muted-foreground">
        <button
          type="button"
          onClick={() => setI((n) => Math.max(0, n - 1))}
          disabled={atStart}
          className="rounded px-2 py-1 hover:text-foreground disabled:opacity-30"
        >
          ← Prev
        </button>
        <span className="tabular-nums">
          {i + 1} / {STEPS.length} · {step.label}
        </span>
        <button
          type="button"
          onClick={() => setI((n) => Math.min(STEPS.length - 1, n + 1))}
          disabled={atEnd}
          className="rounded px-2 py-1 hover:text-foreground disabled:opacity-30"
        >
          Next →
        </button>
      </div>

      <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
        Back to app
      </Button>
    </div>
  )
}
