import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SignInPanel(): React.ReactElement {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [awaitingPaste, setAwaitingPaste] = useState(false)

  const handleSignIn = useCallback(async () => {
    setError(null)
    try {
      await window.auth.oauthStart()
      setAwaitingPaste(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!code.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await window.auth.oauthComplete(code.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [code])

  return (
    <div className="dark fixed inset-0 z-50 flex items-center justify-center bg-background font-sans">
      <div className="flex flex-col items-center text-center max-w-sm">
        {!awaitingPaste ? (
          <>
            <Button onClick={handleSignIn} size="lg">
              Sign in with Claude
            </Button>
            <p className="text-foreground text-base leading-relaxed mt-7 font-normal">
              Use your existing Anthropic<br />subscription to use the agent panel.
            </p>
            <p className="text-muted-foreground text-sm mt-4">
              — More models will be added.
            </p>
          </>
        ) : (
          <div className="flex flex-col items-stretch gap-3 w-80 mt-4">
            <p className="text-foreground text-sm text-center mb-1">
              Paste the authorization code from your browser
            </p>
            <Input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste code here"
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit()
              }}
            />
            <Button
              onClick={handleSubmit}
              disabled={submitting || !code.trim()}
              size="lg"
            >
              {submitting ? 'Connecting...' : 'Connect'}
            </Button>
            {error && (
              <p className="text-destructive text-xs text-center mt-1 break-words">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
