// Onboarding step 1 — Welcome.
//
// Pure view: no side effects. Its only job is identity ("what is Octave") + one
// line of momentum to click. The deeper trust message (the AI can't read
// secrets / send data) lives at the folder step, where the user actually grants
// access — that's where it lands. The real launcher advances to the folder step
// on "Get started"; the /onboard preview renders it with a no-op.

import type { ReactNode } from 'react'
import { IconCheck } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { OnboardingDemo } from '@/profile/ui/onboarding/OnboardingDemo'

const FEATURES = ['Local only', 'Plain Markdown', 'Grounded in your notes', 'Powered by your AI subscription']

interface Props {
  onGetStarted: () => void
  /** Step-progress indicator, rendered above the headline. */
  progress?: ReactNode
}

export function WelcomePanel({ onGetStarted, progress }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: headline + copy anchored to the top, CTA pinned to the bottom
          (justify-between). Generous padding gives the content room to breathe. */}
      <div className="flex h-full flex-col justify-between px-8 py-8">
        <div>
          {progress && <div className="mb-7">{progress}</div>}
          <h1 className="mb-8 text-3xl font-bold leading-tight tracking-tight text-foreground">
            The more you write,
            <br />
            the sharper it edits.
          </h1>
          <ul className="space-y-2 text-body text-muted-foreground">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-2">
                <IconCheck size={16} stroke={2} className="shrink-0 text-muted-foreground" />
                {f}
              </li>
            ))}
          </ul>
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
