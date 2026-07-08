import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Stage = 'idle' | 'authorizing'

interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

type PollResult =
  | { status: 'pending' }
  | { status: 'connected'; login: string }
  | { status: 'denied' }
  | { status: 'expired' }

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onConnected?: () => void
}

/** GitHub Device Flow connect dialog. Mirrors ConnectClaudeDialog's
 * shape: idle → click → show the user code + open github.com/login/device
 * → poll until the user authorizes. The token stays in rust. */
export function ConnectGitHubDialog({ open, onOpenChange, onConnected }: Props) {
  const [stage, setStage] = useState<Stage>('idle')
  const [device, setDevice] = useState<DeviceCodeInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Flips true to stop the poll loop on close/unmount/terminal state.
  const cancelledRef = useRef(false)

  const reset = useCallback(() => {
    cancelledRef.current = true
    setStage('idle')
    setDevice(null)
    setError(null)
    setCopied(false)
  }, [])

  // Stop polling if the dialog unmounts mid-flow.
  useEffect(() => () => { cancelledRef.current = true }, [])

  const poll = useCallback(
    async (intervalSec: number) => {
      while (!cancelledRef.current) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000))
        if (cancelledRef.current) return
        let res: PollResult
        try {
          res = await invoke<PollResult>('poll_github_device_flow')
        } catch (e) {
          if (cancelledRef.current) return
          setError(String(e))
          setStage('idle')
          return
        }
        if (cancelledRef.current) return
        switch (res.status) {
          case 'connected':
            onConnected?.()
            onOpenChange(false)
            reset()
            return
          case 'denied':
            setError('Authorization was declined. Try again.')
            setStage('idle')
            return
          case 'expired':
            setError('The code expired. Start again.')
            setStage('idle')
            return
          case 'pending':
            break // loop again
        }
      }
    },
    [onConnected, onOpenChange, reset],
  )

  async function startSignIn() {
    setError(null)
    cancelledRef.current = false
    try {
      const info = await invoke<DeviceCodeInfo>('start_github_device_flow')
      setDevice(info)
      setStage('authorizing')
      // Open the verification page; ignore failure — the user can still
      // click the inline link.
      try {
        await openUrl(info.verificationUri)
      } catch (e) {
        console.warn('[githubAuth] open verification url failed', e)
      }
      void poll(info.interval)
    } catch (e) {
      setError(String(e))
    }
  }

  async function copyCode() {
    if (!device) return
    try {
      await navigator.clipboard.writeText(device.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked — the user can still read and type the code.
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
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>
            Pull your GitHub activity (commits, PRs) into your timeline.
          </DialogDescription>
        </DialogHeader>

        {stage === 'idle' && (
          <div className="space-y-3 text-body text-muted-foreground">
            <p>
              Click below. Your browser will open to
              github.com/login/device — enter the code shown here to
              authorize.
            </p>
            <Button onClick={startSignIn} className="w-full">
              Sign in to GitHub
            </Button>
            {error && <p className="text-footnote text-destructive">{error}</p>}
          </div>
        )}

        {stage === 'authorizing' && device && (
          <div className="space-y-4">
            <p className="text-body text-muted-foreground">
              Enter this code at{' '}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => void openUrl(device.verificationUri)}
              >
                github.com/login/device
              </button>
              :
            </p>
            <button
              type="button"
              onClick={copyCode}
              className="w-full rounded-lg border bg-muted/40 py-3 text-center font-mono text-2xl tracking-[0.3em] hover:bg-muted"
              title="Click to copy"
            >
              {device.userCode}
            </button>
            <p className="text-center text-footnote text-muted-foreground">
              {copied
                ? 'Copied!'
                : 'Click the code to copy · Waiting for authorization…'}
            </p>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false)
                  reset()
                }}
              >
                Cancel
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
