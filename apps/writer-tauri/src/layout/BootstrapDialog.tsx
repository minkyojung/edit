// First-run welcome dialog. Walks the user through three stages:
//
//   1. Source  — pick which inputs feed the initial memory
//                (Import files / Add URLs). Stage 1 is the only
//                stage with real wiring in this phase.
//   2. Analyze — runs Import + URL pipelines, streams progress.
//                Placeholder until B2 + B4 land.
//   3. Interview — adaptive Q&A that fills gaps the analyze step
//                leaves behind. Placeholder until B5 lands.
//
// The dialog itself owns nothing persistent except the stage index
// and the source checkboxes. Skip / Finish both flip
// settingsStore.bootstrapCompleted so the dialog stays gone across
// app restarts. BootGate (B1.c, next phase) controls when this
// mounts.
//
// Why a shell first: getting the modal + stepper + close behavior
// right is independent of the input pipelines. Landing those in
// later phases means each pipeline can be developed and verified
// against a working chrome, not against a dialog that doesn't
// render yet.

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/state/settingsStore'

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
            onNext={() => setStage(2)}
          />
        )}
        {stage === 2 && (
          <StagePlaceholder
            title="Analyze"
            description="Reading your files / URLs and extracting facts. Pipelines land in a later phase — for now this stage is a stub."
            onBack={() => setStage(1)}
            onNext={() => setStage(3)}
          />
        )}
        {stage === 3 && (
          <StagePlaceholder
            title="Interview"
            description="Adaptive Q&A to fill gaps. Lands in a later phase."
            onBack={() => setStage(2)}
            onNext={handleFinish}
            nextLabel="Finish"
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

interface PlaceholderProps {
  title: string
  description: string
  onBack: () => void
  onNext: () => void
  nextLabel?: string
}

function StagePlaceholder({
  title,
  description,
  onBack,
  onNext,
  nextLabel = 'Next',
}: PlaceholderProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="py-6 text-center text-sm text-muted-foreground">Coming next.</div>
      <DialogFooter className="flex items-center justify-between sm:justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>{nextLabel}</Button>
      </DialogFooter>
    </>
  )
}

// Dev handle so we can verify the dialog renders without wiring it
// into BootGate yet. Removed once B1.c lands (the real entry).
if (import.meta.env.DEV) {
  ;(window as unknown as { BootstrapDialog: typeof BootstrapDialog }).BootstrapDialog = BootstrapDialog
}
