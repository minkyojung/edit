// Onboarding step — Connect Claude (rough skeleton).
//
// Octave's AI needs a Claude account. This is skippable ("do it later") so it's
// an offer, not a wall — a returning-user launcher / the JIT prompt in the
// editor covers anyone who defers. Pure view: the real launcher wires the OAuth
// connect flow (ConnectClaudeDialog) later; for now both actions advance.

import { Button } from '@/components/ui/button'

interface Props {
  onConnect: () => void
  onLater: () => void
}

export function ConnectPanel({ onConnect, onLater }: Props) {
  return (
    <div className="grid h-full w-full grid-cols-2 bg-background">
      {/* Left: copy + actions */}
      <div className="flex flex-col justify-center px-10 py-8">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground">
          Connect your Claude account
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Octave&apos;s AI is powered by your Claude account. Connect it so the
          AI can read and edit your notes alongside you. You can always do this
          later, when you first ask the AI for something.
        </p>
        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={onConnect}>
            Connect Claude
          </Button>
        </div>
        <button
          type="button"
          onClick={onLater}
          className="mt-6 self-start text-footnote text-muted-foreground transition-colors hover:text-foreground"
        >
          I&apos;ll do this later
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
