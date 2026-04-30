import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type Stage = 'idle' | 'waiting' | 'submitting'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

export function ConnectClaudeDialog({ open, onOpenChange }: Props) {
  const [stage, setStage] = useState<Stage>('idle')
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setStage('idle')
    setPasted('')
    setError(null)
  }

  async function startSignIn() {
    setError(null)
    try {
      await invoke('start_claude_oauth')
      setStage('waiting')
    } catch (e) {
      setError(String(e))
    }
  }

  async function submitCode() {
    if (!pasted.trim()) return
    setStage('submitting')
    setError(null)
    try {
      await invoke('complete_claude_oauth', { pasted: pasted.trim() })
      onOpenChange(false)
      reset()
    } catch (e) {
      setError(String(e))
      setStage('waiting')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) reset()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Claude</DialogTitle>
          <DialogDescription>
            Use your Claude subscription to power AI features in this app.
          </DialogDescription>
        </DialogHeader>

        {stage === 'idle' && (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Click the button below. Your browser will open to claude.ai. After you authorize,
              copy the code shown and paste it back here.
            </p>
            <Button onClick={startSignIn} className="w-full">
              Sign in to Claude
            </Button>
          </div>
        )}

        {(stage === 'waiting' || stage === 'submitting') && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Paste the authentication code from your browser:
            </p>
            <Input
              autoFocus
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCode()
              }}
              placeholder="AUTHCODE#STATE"
              disabled={stage === 'submitting'}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => { onOpenChange(false); reset() }}>
                Cancel
              </Button>
              <Button onClick={submitCode} disabled={stage === 'submitting' || !pasted.trim()}>
                {stage === 'submitting' ? 'Connecting…' : 'Connect'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {error && stage === 'idle' && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
