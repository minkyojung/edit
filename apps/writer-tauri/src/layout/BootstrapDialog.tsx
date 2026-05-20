// First-run welcome dialog. Stages:
//
//   1. Source  — pick which inputs feed the initial memory (Import
//                files / Add URLs). Stage 1 is fully wired.
//   2. Analyze — when Import is selected, runs the file picker +
//                bootstrapIngest loop and streams progress. URL
//                fetch lands in B4 (silently skipped for now).
//   3. Interview — adaptive Q&A. Lands in B5; currently skipped
//                entirely so the user sees Finish straight from
//                Stage 2 instead of a "coming soon" placeholder.
//
// The dialog itself owns nothing persistent except the stage index
// and the source checkboxes. Skip / Finish both flip
// settingsStore.bootstrapCompleted so the dialog stays gone across
// app restarts. BootGate controls when this mounts.

import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useSettingsStore } from '@/state/settingsStore'
import { notify } from '@/lib/notify'
import {
  runImport,
  type ImportProgress,
  type ImportResult,
} from '@/agent/import/runImport'

type Stage = 1 | 2 | 3

interface Props {
  open: boolean
  onClose: () => void
}

export function BootstrapDialog({ open, onClose }: Props) {
  const [stage, setStage] = useState<Stage>(1)
  const [importSelected, setImportSelected] = useState(false)
  const [urlSelected, setUrlSelected] = useState(false)
  const markCompleted = useSettingsStore((s) => s.markBootstrapCompleted)

  const handleSkip = () => {
    markCompleted()
    onClose()
  }

  const handleFinish = () => {
    markCompleted()
    onClose()
  }

  // Stage 1 → next button decides which path to take. Import wins
  // when it's checked (since Stage 2 is the only wired pipeline);
  // URL-only falls through to Finish for now (B4 will pick this up).
  const handleNextFromStage1 = () => {
    if (importSelected) {
      setStage(2)
    } else {
      // URL-only or neither — nothing to do until B4 lands.
      handleFinish()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing via Esc / outside-click counts as Skip — bootstrap
        // is one-shot and shouldn't reappear next launch just
        // because the user dismissed it casually.
        if (!next) handleSkip()
      }}
    >
      <DialogContent className="max-w-lg">
        <Stepper stage={stage} />
        {stage === 1 && (
          <Stage1
            importSelected={importSelected}
            urlSelected={urlSelected}
            onToggleImport={() => setImportSelected((v) => !v)}
            onToggleUrl={() => setUrlSelected((v) => !v)}
            onSkip={handleSkip}
            onNext={handleNextFromStage1}
          />
        )}
        {stage === 2 && (
          <Stage2Analyze
            onCancel={() => setStage(1)}
            onFinish={handleFinish}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Stepper({ stage }: { stage: Stage }) {
  const labels: Array<{ id: Stage; label: string }> = [
    { id: 1, label: 'Source' },
    { id: 2, label: 'Analyze' },
    { id: 3, label: 'Interview' },
  ]
  return (
    <div className="flex items-center justify-center gap-2 pb-2 text-xs text-muted-foreground">
      {labels.map((step, i) => (
        <div key={step.id} className="flex items-center gap-2">
          <span
            className={
              'flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ' +
              (step.id === stage
                ? 'border-foreground bg-foreground text-background'
                : step.id < stage
                  ? 'border-foreground/40 text-foreground/40'
                  : 'border-muted-foreground/30')
            }
          >
            {step.id}
          </span>
          <span className={step.id === stage ? 'text-foreground' : ''}>{step.label}</span>
          {i < labels.length - 1 && <span className="w-4 border-t border-muted-foreground/30" />}
        </div>
      ))}
    </div>
  )
}

interface Stage1Props {
  importSelected: boolean
  urlSelected: boolean
  onToggleImport: () => void
  onToggleUrl: () => void
  onSkip: () => void
  onNext: () => void
}

function Stage1({
  importSelected,
  urlSelected,
  onToggleImport,
  onToggleUrl,
  onSkip,
  onNext,
}: Stage1Props) {
  const canProceed = importSelected || urlSelected
  return (
    <>
      <DialogHeader>
        <DialogTitle>Set up your memory</DialogTitle>
        <DialogDescription>
          Pick where your initial memory should come from. You can always add more later.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2 py-2">
        <SourceRow
          checked={importSelected}
          onToggle={onToggleImport}
          title="Import files"
          subtitle=".md, .txt, .json from another app"
        />
        <SourceRow
          checked={urlSelected}
          onToggle={onToggleUrl}
          title="Add URLs"
          subtitle="Blog posts, wikis, anything public on the web"
        />
      </div>
      <DialogFooter className="flex items-center justify-between sm:justify-between">
        <Button variant="ghost" onClick={onSkip} className="text-muted-foreground">
          Skip &amp; start blank
        </Button>
        <Button onClick={onNext} disabled={!canProceed}>
          Next
        </Button>
      </DialogFooter>
    </>
  )
}

function SourceRow({
  checked,
  onToggle,
  title,
  subtitle,
}: {
  checked: boolean
  onToggle: () => void
  title: string
  subtitle: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={
        'flex items-start gap-3 rounded-md border p-3 text-left transition-colors ' +
        (checked
          ? 'border-foreground bg-muted/40'
          : 'border-border hover:bg-muted/30')
      }
    >
      <span
        className={
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ' +
          (checked ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/40')
        }
        aria-hidden="true"
      >
        {checked ? '✓' : ''}
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  )
}

interface Stage2Props {
  /** User cancelled the OS picker (no files chosen). Stage 1 takes
   * over so they can pick again or hit Skip. */
  onCancel: () => void
  /** Import finished (at least one file processed). Closes the
   * dialog and persists bootstrapCompleted. */
  onFinish: () => void
}

function Stage2Analyze({ onCancel, onFinish }: Stage2Props) {
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const startedRef = useRef(false)

  // Fire the import exactly once on mount. React StrictMode double-
  // mounts every dev-time effect, which would open the OS picker
  // twice; the ref short-circuits the second run. (Not an issue in
  // production, but the dev experience matters during dogfood.)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void (async () => {
      try {
        const res = await runImport({ onProgress: setProgress })
        setResult(res)
        if (res.filesProcessed === 0) {
          // User cancelled the picker — bounce back to Stage 1 so
          // they can retry or hit Skip explicitly.
          onCancel()
          return
        }
        // Surface the outcome BEFORE closing the dialog so the toast
        // is the persistent feedback while the modal animates out.
        // Without this the dialog just disappears and the user has
        // no idea whether the LLM extracted anything (a valid 0-
        // proposal result looks identical to a 12-proposal result).
        notify.bootstrapImportComplete({
          filesProcessed: res.filesProcessed,
          filesFailed: res.filesFailed,
          totalProposals: res.totalProposals,
        })
        onFinish()
      } catch (err) {
        // runImport itself doesn't throw (per-file errors are
        // caught inside), but be defensive: surface to console
        // and let the user pick again via Stage 1.
        console.error('[bootstrap] runImport failed', err)
        onCancel()
      }
    })()
    // onCancel / onFinish are stable refs from the parent's
    // closure — including them would re-fire on every parent
    // render, which the ref guard already prevents but eslint
    // doesn't know that. Empty deps is correct here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusLine = (() => {
    if (result) {
      const noun = result.totalProposals === 1 ? 'proposal' : 'proposals'
      return `Done. ${result.totalProposals} ${noun} queued.`
    }
    if (progress) {
      const noun = progress.proposalsCount === 1 ? 'proposal' : 'proposals'
      return `Reading ${progress.filesDone} / ${progress.filesTotal} files… ${progress.proposalsCount} ${noun} so far.`
    }
    return 'Pick the files to import.'
  })()

  return (
    <>
      <DialogHeader>
        <DialogTitle>Analyzing your notes</DialogTitle>
        <DialogDescription>{statusLine}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-center py-8">
        {result ? null : <Spinner />}
      </div>
    </>
  )
}

// Dev handle so we can verify the dialog renders without wiring it
// into BootGate yet. Removed once B1.c lands (the real entry).
if (import.meta.env.DEV) {
  ;(window as unknown as { BootstrapDialog: typeof BootstrapDialog }).BootstrapDialog = BootstrapDialog
}
