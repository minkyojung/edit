// Presentational welcome + folder-pick panel — the first onboarding step.
//
// Pure view: no window resize, no store, no side effects. The real launcher
// (OnboardingLauncher) wires the actual folder-pick / skip handlers and does
// the window sizing; the /onboard design-preview page renders this same panel
// with no-op handlers so the layout can be iterated without restarting the app.

import { Button } from '@/components/ui/button'

interface Props {
  onChooseFolder: () => void
  onNewTranslation: () => void
  onSkip: () => void
}

export function WelcomePanel({ onChooseFolder, onNewTranslation, onSkip }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: copy + actions */}
      <div className="flex flex-col justify-center px-10 py-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
          Welcome to Octave
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          A local, plain-text writing space with an AI that works alongside you.
          Your notes are just Markdown files in a folder you choose — let&apos;s
          pick where they&apos;ll live.
        </p>
        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={onChooseFolder}>
            Choose a folder for my notes
          </Button>
          <Button variant="outline" className="w-full" onClick={onNewTranslation}>
            New translation project
          </Button>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="mt-6 self-start text-footnote text-muted-foreground transition-colors hover:text-foreground"
        >
          Skip
        </button>
      </div>

      {/* Right: preview panel (placeholder — swap for a real image later) */}
      <div className="flex items-center justify-center p-4">
        <div className="flex h-full w-full items-center justify-center rounded-2xl bg-gradient-to-br from-muted/60 to-muted/20">
          <span className="text-footnote text-muted-foreground/60">Preview image</span>
        </div>
      </div>
    </div>
  )
}
