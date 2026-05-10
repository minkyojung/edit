// Renders nothing until the bundled proof-server is reachable, so the
// rest of the app never has to handle the "engine not up" state. On a
// healthy cold start the user sees a brief "Starting…" indicator (or
// nothing at all if the server beats the loader-delay). On failure
// they get an explicit error card with a Retry that respawns the
// server and resumes polling.
//
// Two failure modes covered:
//   1. Spawn returned a pid but the server never started serving (port
//      held by another process, crash on boot, etc.) — health check
//      keeps timing out.
//   2. Spawn itself failed (bun missing in dev, bundled binary missing
//      in prod) — pgid is 0 and respawn surfaces the error string.
//
// The gate intentionally lives outside the ErrorBoundary so a render
// error here can't be swallowed by the same fallback that would itself
// rely on the engine being up.

import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

type Status = 'checking' | 'ready' | 'failed'

const POLL_INTERVAL_MS = 250
const MAX_ATTEMPTS = 12 // 12 × 250ms = 3s before giving up
const LOADER_DELAY_MS = 400 // delay showing the spinner so a fast boot doesn't flash

interface Props {
  children: React.ReactNode
}

export function EngineGate({ children }: Props) {
  const [status, setStatus] = useState<Status>('checking')
  const [error, setError] = useState<string | null>(null)
  const [showLoader, setShowLoader] = useState(false)
  // Survives across retries so we can cancel an in-flight poll when the
  // user clicks Retry mid-loop.
  const pollGen = useRef(0)

  const startPolling = useCallback(async () => {
    setStatus('checking')
    setError(null)
    setShowLoader(false)
    const myGen = ++pollGen.current
    const loaderTimer = window.setTimeout(() => {
      if (pollGen.current === myGen) setShowLoader(true)
    }, LOADER_DELAY_MS)

    let lastErr = 'unreachable'
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (pollGen.current !== myGen) {
        window.clearTimeout(loaderTimer)
        return
      }
      try {
        await invoke('check_proof_server_health')
        if (pollGen.current === myGen) {
          window.clearTimeout(loaderTimer)
          setStatus('ready')
        }
        return
      } catch (e) {
        lastErr = String(e)
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    if (pollGen.current === myGen) {
      window.clearTimeout(loaderTimer)
      setError(lastErr)
      setStatus('failed')
    }
  }, [])

  useEffect(() => {
    startPolling()
    return () => {
      // Cancel any in-flight loop on unmount.
      pollGen.current++
    }
  }, [startPolling])

  const onRetry = useCallback(async () => {
    setStatus('checking')
    setError(null)
    setShowLoader(true)
    try {
      await invoke('respawn_proof_server')
    } catch (e) {
      setError(String(e))
      setStatus('failed')
      return
    }
    startPolling()
  }, [startPolling])

  if (status === 'ready') return <>{children}</>

  if (status === 'failed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <div className="max-w-md space-y-3 rounded-md border border-border bg-card p-6 text-center">
          <IconAlertTriangle size={28} stroke={1.5} className="mx-auto text-destructive" />
          <h2 className="text-base font-medium text-foreground">
            Couldn&apos;t start the engine
          </h2>
          <p className="text-xs text-muted-foreground break-words">
            Another app may be using port 4000, or the bundled server failed to launch.
          </p>
          {error && (
            <p className="text-[11px] text-muted-foreground/70 break-words font-mono">
              {error}
            </p>
          )}
          <div className="flex justify-center gap-2 pt-2">
            <Button size="sm" onClick={onRetry}>Retry</Button>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // checking
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      {showLoader && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner />
          <span>Starting…</span>
        </div>
      )}
    </div>
  )
}
