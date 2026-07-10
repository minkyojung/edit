// Onboarding step progress — an inline dot row. Each panel places it at the top
// of its own content (above the headline) so it aligns with the copy instead of
// floating over the 2-column divider. Shared so the live launcher and the
// /onboard design preview render the exact same indicator. Hidden on the
// celebratory done step.

import { cn } from '@/lib/utils'

export type OnboardingStep = 'welcome' | 'connect' | 'claude' | 'folder' | 'done'

const DOT_STEPS: OnboardingStep[] = ['welcome', 'connect', 'claude', 'folder']

export function StepDots({ step }: { step: OnboardingStep }) {
  if (step === 'done') return null
  const active = DOT_STEPS.indexOf(step)
  return (
    <div className="flex gap-1.5">
      {DOT_STEPS.map((s, i) => (
        <span
          key={s}
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            i === active ? 'w-5 bg-foreground/80' : 'w-1.5 bg-foreground/30',
          )}
        />
      ))}
    </div>
  )
}
