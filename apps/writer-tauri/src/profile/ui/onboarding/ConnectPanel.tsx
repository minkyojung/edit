// Onboarding step — Sign in to Octave with Google.
//
// This is the identity step: one-click Google sign-in gives us the user's name,
// email, and picture. It's an offer, not a wall — "Start without an account"
// skips it. Claude (the AI engine) is a separate concern, connected just-in-time
// the first time the user asks the AI for something, not here.
//
// Pure view: the real launcher owns useGoogleAuth and passes `onContinue`
// (the loopback sign-in), `connecting`, and any `error`. The /onboard preview
// passes no-ops.

import { Button } from '@/components/ui/button'

interface Props {
  onContinue: () => void
  onLater: () => void
  connecting?: boolean
  error?: string | null
}

export function ConnectPanel({ onContinue, onLater, connecting, error }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: copy + actions */}
      <div className="flex flex-col justify-center px-10 py-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
          Sign in to Octave
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Sign in with Google so Octave knows who you are — your name and email
          personalize your workspace. It only takes a click, and you can do it
          later.
        </p>
        <div className="flex flex-col gap-2">
          <Button className="w-full gap-2" onClick={onContinue} disabled={connecting}>
            <GoogleGlyph />
            {connecting ? 'Waiting for Google…' : 'Continue with Google'}
          </Button>
        </div>
        {error && <p className="mt-3 text-footnote text-destructive">{error}</p>}
        <button
          type="button"
          onClick={onLater}
          disabled={connecting}
          className="mt-6 self-start text-footnote text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          Start without an account
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

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}
