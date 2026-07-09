// Onboarding step 1 — Welcome.
//
// Pure view: no side effects. Its only job is identity ("what is Octave") + one
// line of momentum to click. The deeper trust message (the AI can't read
// secrets / send data) lives at the folder step, where the user actually grants
// access — that's where it lands. The real launcher advances to the folder step
// on "Get started"; the /onboard preview renders it with a no-op.

import { Button } from '@/components/ui/button'
import { OnboardingDemo } from '@/profile/ui/onboarding/OnboardingDemo'

interface Props {
  onGetStarted: () => void
}

export function WelcomePanel({ onGetStarted }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: headline + copy anchored to the top, CTA pinned to the bottom
          (justify-between). Generous padding gives the content room to breathe. */}
      <div className="flex h-full flex-col justify-between px-8 py-8">
        <div>
          <h1 className="mb-4 text-3xl font-bold leading-tight tracking-tight text-foreground">
            Delegate to yourself.
          </h1>
          <p className="text-body leading-relaxed text-muted-foreground">
            Years of your writing — Obsidian, Substack, notes — become an AI that
            thinks in your voice and takes work off your hands.
          </p>
        </div>
        <Button className="h-12 w-full rounded-xl" onClick={onGetStarted}>
          Get started
        </Button>
      </div>

      {/* Right: auto-playing product demo (request → search → propose → keep). */}
      <div className="bg-gradient-to-br from-muted/60 to-muted/20">
        <OnboardingDemo />
      </div>
    </div>
  )
}
