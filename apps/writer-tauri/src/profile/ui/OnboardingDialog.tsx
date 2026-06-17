// First-run onboarding modal. Drives runProfilePipeline and renders
// progress as the run advances:
//
//   Stage "input"   — URL field + Analyze button
//   Stage "running" — discovery line + one line per section (pending
//                     → loading → done)
//   Stage "done"    — "Open profile" navigates to wiki:profile
//   Stage "failed"  — error message + retry
//
// All state is local. The pipeline itself doesn't touch the dialog;
// we subscribe via the onProgress callback. seedDocBody is one-shot
// so a partial run leaves no half-written profile page — the dialog
// just falls back to the input stage on retry.

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { IconCheck, IconAlertCircle } from '@tabler/icons-react'
import { useNavigate } from 'react-router-dom'
import { useDocsStore } from '@/state/docsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import {
  runProfilePipeline,
  type PipelineProgress,
} from '@/profile/pipeline'
import {
  PROFILE_SECTIONS,
  type ProfileSectionKey,
} from '@/profile/conventions'

interface Props {
  open: boolean
  onClose: () => void
}

type Stage = 'input' | 'running' | 'done' | 'failed'

interface SectionStatus {
  status: 'pending' | 'loading' | 'done'
}

const SECTION_KEYS: ProfileSectionKey[] = ['voice', 'themes', 'about']
const SECTION_LABEL: Record<ProfileSectionKey, string> = {
  voice: 'Voice',
  themes: 'Themes',
  about: 'About',
}

export function OnboardingDialog({ open, onClose }: Props) {
  const [stage, setStage] = useState<Stage>('input')
  const [url, setUrl] = useState('')
  const [discoveryLabel, setDiscoveryLabel] = useState<string | null>(null)
  const [sectionStatus, setSectionStatus] = useState<
    Record<ProfileSectionKey, SectionStatus>
  >({
    voice: { status: 'pending' },
    themes: { status: 'pending' },
    about: { status: 'pending' },
  })
  const [savedSlug, setSavedSlug] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const navigate = useNavigate()
  const markBootstrapCompleted = useSettingsStore(
    (s) => s.markBootstrapCompleted,
  )

  const resetToInput = () => {
    setStage('input')
    setDiscoveryLabel(null)
    setSectionStatus({
      voice: { status: 'pending' },
      themes: { status: 'pending' },
      about: { status: 'pending' },
    })
    setSavedSlug(null)
    setErrorMessage(null)
  }

  const handleProgress = (p: PipelineProgress) => {
    switch (p.kind) {
      case 'fetched':
        setDiscoveryLabel(
          `Found ${p.count} ${p.count === 1 ? 'post' : 'posts'} via ${p.adapter}`,
        )
        return
      case 'no_documents':
        setErrorMessage(
          "Couldn't find any posts at that URL. Try a blog homepage or feed URL.",
        )
        setStage('failed')
        return
      case 'section_start':
        setSectionStatus((prev) => ({
          ...prev,
          [p.section]: { status: 'loading' },
        }))
        return
      case 'section_done':
        setSectionStatus((prev) => ({
          ...prev,
          [p.section]: { status: 'done' },
        }))
        return
      case 'done':
        setSavedSlug(p.slug)
        setStage('done')
        return
      case 'error':
        setErrorMessage(p.message)
        setStage('failed')
        return
      default:
        return
    }
  }

  const handleAnalyze = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setStage('running')
    setErrorMessage(null)
    setDiscoveryLabel('Searching for posts…')
    try {
      await runProfilePipeline(trimmed, handleProgress)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
      setStage('failed')
    }
  }

  const handleOpenProfile = () => {
    if (savedSlug) {
      const store = useDocsStore.getState()
      navigate(
        buildViewUrl({
          tab: store.sidebarTab,
          dayAnchor: store.dayAnchor,
          monthAnchor: store.monthAnchor,
          slug: savedSlug,
        }),
      )
    }
    markBootstrapCompleted()
    onClose()
  }

  const handleSkip = () => {
    markBootstrapCompleted()
    onClose()
  }

  // Dialog can't be dismissed during a run (would leave the pipeline
  // running with nowhere to surface results). Esc + outside-click
  // are intercepted by Radix's onOpenChange — we only forward when
  // we're idle or finished.
  const allowDismiss = stage === 'input' || stage === 'done' || stage === 'failed'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && allowDismiss) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-[480px]"
        onEscapeKeyDown={(e) => {
          if (!allowDismiss) e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (!allowDismiss) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Tell us where you write</DialogTitle>
          <DialogDescription>
            We'll read a few recent posts and draft a profile page you can edit.
          </DialogDescription>
        </DialogHeader>

        {stage === 'input' && (
          <InputStage
            url={url}
            setUrl={setUrl}
            onAnalyze={handleAnalyze}
            onSkip={handleSkip}
          />
        )}

        {stage === 'running' && (
          <RunningStage
            discoveryLabel={discoveryLabel}
            sectionStatus={sectionStatus}
          />
        )}

        {stage === 'done' && (
          <DoneStage onOpen={handleOpenProfile} />
        )}

        {stage === 'failed' && (
          <FailedStage
            message={errorMessage ?? 'Something went wrong.'}
            onRetry={resetToInput}
            onSkip={handleSkip}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function InputStage({
  url,
  setUrl,
  onAnalyze,
  onSkip,
}: {
  url: string
  setUrl: (v: string) => void
  onAnalyze: () => void
  onSkip: () => void
}) {
  const canAnalyze = url.trim().length > 0
  return (
    <div className="flex flex-col gap-3">
      <Input
        autoFocus
        placeholder="https://blog.example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canAnalyze) onAnalyze()
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip
        </Button>
        <Button size="sm" onClick={onAnalyze} disabled={!canAnalyze}>
          Analyze
        </Button>
      </div>
    </div>
  )
}

function RunningStage({
  discoveryLabel,
  sectionStatus,
}: {
  discoveryLabel: string | null
  sectionStatus: Record<ProfileSectionKey, SectionStatus>
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <ProgressLine
        status={discoveryLabel?.startsWith('Found') ? 'done' : 'loading'}
        label={discoveryLabel ?? 'Searching for posts…'}
      />
      {SECTION_KEYS.map((key) => (
        <ProgressLine
          key={key}
          status={sectionStatus[key].status}
          label={SECTION_LABEL[key]}
        />
      ))}
    </div>
  )
}

function ProgressLine({
  status,
  label,
}: {
  status: 'pending' | 'loading' | 'done'
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      {status === 'pending' && (
        <span className="size-4 rounded-full border border-muted-foreground/30" />
      )}
      {status === 'loading' && <Spinner className="size-4" />}
      {status === 'done' && <IconCheck className="size-4 text-success" />}
      <span
        className={
          status === 'pending' ? 'text-muted-foreground' : 'text-foreground'
        }
      >
        {label}
      </span>
    </div>
  )
}

function DoneStage({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Your profile is ready. Open it to review and edit.
      </p>
      <div className="flex justify-end">
        <Button size="sm" onClick={onOpen}>
          Open profile
        </Button>
      </div>
    </div>
  )
}

function FailedStage({
  message,
  onRetry,
  onSkip,
}: {
  message: string
  onRetry: () => void
  onSkip: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <IconAlertCircle className="size-4 mt-0.5 text-warning" />
        <span>{message}</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip
        </Button>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

// Keep PROFILE_SECTIONS referenced so the keys above stay in sync if
// someone adds/removes a section in conventions.ts (type-only use
// wouldn't catch a missing label).
void PROFILE_SECTIONS
