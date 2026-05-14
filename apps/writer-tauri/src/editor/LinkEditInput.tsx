// URL input shared by both link-edit surfaces (FormatToolbar's link
// button and LinkHoverBar's edit action). Owns its own ephemeral
// text state — initial value is seeded from the prop, subsequent
// edits are local until the user commits via Enter.
//
// Enter applies, Escape cancels. The parent decides what "apply" and
// "cancel" mean (close popover, refocus editor, etc.).

import { useEffect, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'

interface LinkEditInputProps {
  initialValue: string
  onApply: (href: string) => void
  onCancel: () => void
}

export function LinkEditInput({ initialValue, onApply, onCancel }: LinkEditInputProps) {
  const [url, setUrl] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Radix's Popover steals focus on open; delay one tick so the
  // input wins the focus race.
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  return (
    <Input
      ref={inputRef}
      type="url"
      value={url}
      onChange={(e) => setUrl(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onApply(url)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      placeholder="https://…"
      className="h-8 px-3 text-sm"
    />
  )
}
