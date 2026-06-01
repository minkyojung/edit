import React from 'react'
import { IconCheck, IconCopy } from '@tabler/icons-react'

/** Copy button. Writes the message text to the clipboard and flips to a
 * checkmark for ~1.5s as confirmation. Errors are swallowed silently —
 * Tauri's webview clipboard call is reliable enough that surfacing a
 * failure here would just be noise. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard denied or unavailable — leave UI unchanged.
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy'}
      className="inline-flex items-center rounded p-0.5 text-muted-foreground/70 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  )
}
