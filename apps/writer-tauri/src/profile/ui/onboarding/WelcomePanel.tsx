// Onboarding step 1 — Welcome + trust.
//
// Pure view: no side effects. Sets identity ("what is Octave") and primes trust
// for an AI that touches the user's files (the security lockdown we ship). The
// real launcher advances to the folder step on "Get started"; the /onboard
// preview renders it with a no-op.

import { Button } from '@/components/ui/button'

interface Props {
  onGetStarted: () => void
}

export function WelcomePanel({ onGetStarted }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: copy + action */}
      <div className="flex flex-col justify-center px-10 py-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
          Welcome to Octave
        </h1>
        <p className="mb-4 text-body leading-relaxed text-muted-foreground">
          A local, plain-text writing space with an AI that works alongside you.
          Your notes are just Markdown files on your own machine.
        </p>
        <p className="mb-8 text-footnote leading-relaxed text-muted-foreground">
          The AI works inside your folder — it can&apos;t read your secrets or
          send your data anywhere. Everything stays on your computer.
        </p>
        <Button className="w-fit px-8" onClick={onGetStarted}>
          Get started
        </Button>
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
