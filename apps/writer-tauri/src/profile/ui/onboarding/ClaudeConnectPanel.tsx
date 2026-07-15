// Onboarding step — Connect Claude (the AI engine).
//
// The "do" step for the AI, styled like FolderPanel: a single centred column,
// not the 2-column sell screens. Click "Continue with Claude" → the browser
// opens to claude.ai (start_claude_oauth); the panel then reveals a paste field
// for the authorization code (complete_claude_oauth). Skippable — the chat
// panel re-prompts sign-in later if skipped here.
//
// The launcher owns the actual OAuth invokes (passed as onStart / onSubmit) and
// advances the flow on a successful submit; the /onboard preview passes
// resolving no-ops so both stages are viewable with zero side effects.
//
// TODO(post-connect): surface a "found your Claude Code setup — import your
// commands & agents?" nudge here once connected (detect ~/.claude).

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  /** Kick off OAuth (opens the browser). Resolves once the browser is launched. */
  onStart: () => Promise<void>
  /** Submit the pasted authorization code. Rejects on failure; on success the
   *  launcher advances the flow and this panel unmounts. */
  onSubmit: (code: string) => Promise<void>
  onLater: () => void
  /** Step-progress indicator, rendered (centred) above the headline. */
  progress?: ReactNode
}

type Stage = 'idle' | 'waiting' | 'submitting'

export function ClaudeConnectPanel({ onStart, onSubmit, onLater, progress }: Props) {
  const [stage, setStage] = useState<Stage>('idle')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setError(null)
    try {
      await onStart()
      setStage('waiting')
    } catch (e) {
      setError(String(e))
    }
  }

  async function submit() {
    if (!code.trim()) return
    setStage('submitting')
    setError(null)
    try {
      await onSubmit(code.trim())
      // Success → the launcher advances to the next step; nothing to do here.
    } catch (e) {
      setError(String(e))
      setStage('waiting')
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-8">
      <div className="w-full max-w-[420px] text-center">
        {progress && <div className="mb-6 flex justify-center">{progress}</div>}
        <h1 className="mb-3 text-3xl font-bold leading-tight tracking-tight text-foreground">
          Connect Claude
        </h1>
        <p className="mb-8 text-body leading-relaxed text-muted-foreground">
          Authorize on claude.ai, then paste the code it gives you here.
        </p>

        {stage === 'idle' ? (
          <Button className="h-12 w-full gap-2 rounded-xl" onClick={() => void start()}>
            <ClaudeGlyph />
            Continue with Claude
          </Button>
        ) : (
          <div className="flex flex-col gap-3 text-left">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the authorization code"
              autoFocus
              className="h-11 rounded-xl"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                className="h-11 flex-1 rounded-xl"
                onClick={() => void submit()}
                disabled={!code.trim() || stage === 'submitting'}
              >
                {stage === 'submitting' ? 'Connecting…' : 'Connect'}
              </Button>
              <Button
                variant="ghost"
                className="h-11 rounded-xl"
                onClick={() => void start()}
                disabled={stage === 'submitting'}
              >
                Reopen
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-footnote text-destructive">{error}</p>}

        <div className="mt-4">
          <button
            type="button"
            onClick={onLater}
            disabled={stage === 'submitting'}
            className="text-footnote text-muted-foreground/70 underline underline-offset-2 hover:text-foreground disabled:opacity-40"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}

function ClaudeGlyph() {
  // Minimal radiating burst — reads as Claude/Anthropic without reproducing the
  // exact trademark. Inherits the button's text color.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i * Math.PI) / 4
        const x = 8 + Math.cos(a) * 6
        const y = 8 + Math.sin(a) * 6
        return (
          <line
            key={i}
            x1="8"
            y1="8"
            x2={x.toFixed(2)}
            y2={y.toFixed(2)}
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        )
      })}
    </svg>
  )
}
