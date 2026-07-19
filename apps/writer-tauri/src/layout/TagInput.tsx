// Inline tag editor for the properties panel: existing tags render as
// removable pills, and a borderless input adds new ones. Enter or comma
// commits the typed text; Backspace on an empty input removes the last tag.
// Calls `onChange` with the full next list on every add/remove — the store
// action owns normalization (trim / de-dupe).

import { useState, type KeyboardEvent } from 'react'
import { IconX } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'

export function TagInput({
  tags,
  onChange,
}: {
  tags: string[]
  onChange: (next: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  function commitDraft() {
    const t = draft.trim()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Don't act on the Enter/Backspace that finishes an IME composition
    // (e.g. confirming a Hangul syllable) — otherwise a half-composed tag
    // gets committed. Matches EditableTitleInput's guard.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitDraft()
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-0.5 pr-1">
          {tag}
          <button
            type="button"
            aria-label={`${tag} 제거`}
            // Keep focus in the input so its onBlur doesn't fire first and
            // commit the in-progress draft against a stale tag list.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <IconX size={11} stroke={2} />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commitDraft}
        placeholder={tags.length === 0 ? '태그 추가…' : ''}
        aria-label="태그 추가"
        className="min-w-24 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  )
}
