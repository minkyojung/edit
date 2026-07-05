/**
 * EditableTitleInput — title surface for user-editable docs.
 *
 * Sits above the body, plays the role of the file's name on disk:
 *   - User types here → renameDoc → fs.rename on the next flush.
 *   - Body content is independent; editing the body never affects the
 *     filename (Path C Step 4's "title separation" decision, Obsidian model).
 *
 * Commit strategy — onBlur AND Enter:
 *   The input keeps a local draft while editing so each keystroke
 *   doesn't trigger an fs.rename ("Sa", "Sar", "Sara", "Sarah" would
 *   otherwise rename four times, leaving the old files around for a
 *   moment each). The draft is committed when the user moves focus
 *   away (blur) or presses Enter — that's "one rename per intent".
 *   Escape reverts without committing.
 *
 * Validation:
 *   - Empty string: revert to current title (no-op rename).
 *   - Same as current: no-op (renameDoc has the same guard, but doing
 *     it here too avoids an unnecessary dirty mark + flush.)
 *   - Anything else: passed through to renameDoc; sanitizeFilename
 *     (in lib/docPaths.ts) handles fs-reserved chars at the disk-write
 *     boundary. We don't refuse them in the UI because typing slash
 *     during a name is common (e.g. "Tom / Boston") — the sanitizer
 *     replaces them with ' - ' downstream and the user sees the
 *     resulting filename in Finder.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useDocsStore } from '@/state/docsStore'
import { useObservePageTitle } from '@/hooks/useObservePageTitle'
import { cn } from '@/lib/utils'

interface Props {
  slug: string
  /** Falls back to 'Untitled' in display; renameDoc refuses empty
   * input so 'Untitled' never becomes a real stored title. */
  currentTitle: string | undefined
}

export function EditableTitleInput({ slug, currentTitle }: Props) {
  const renameDoc = useDocsStore((s) => s.renameDoc)
  // Local draft state — what's in the input box right now. Synced
  // from props when the slug changes (tab switch) but otherwise the
  // user owns it.
  const [draft, setDraft] = useState(currentTitle ?? '')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useObservePageTitle(inputRef)

  // Re-sync draft whenever the underlying doc's title changes. This
  // covers two cases:
  //   1. Tab switch (slug change) — draft must reflect the new doc.
  //   2. External rename (Command Palette / file watcher, future) —
  //      the input should update to match without the user retyping.
  // Skipped when the user is mid-edit (input focused) so we don't
  // clobber their in-progress typing.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return
    setDraft(currentTitle ?? '')
  }, [slug, currentTitle])

  const commit = () => {
    const trimmed = draft.trim()
    // Empty input: revert to the current title. renameDoc rejects
    // empty anyway, but resetting the draft here is what the user
    // sees — an empty input shouldn't stay empty after blur.
    if (trimmed.length === 0) {
      setDraft(currentTitle ?? '')
      return
    }
    if (trimmed === (currentTitle ?? '')) return
    renameDoc(slug, trimmed)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME-safe: while composing (Korean/Japanese), Enter confirms the
    // composition — don't let it commit/blur or insert a newline.
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      // Blur fires the same commit path. Doing it via blur (not
      // calling commit() directly) means the user sees focus leave
      // the input — useful feedback that the rename "took".
      inputRef.current?.blur()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(currentTitle ?? '')
      inputRef.current?.blur()
    }
  }

  return (
    // A <textarea>, not <input>: a single-line input can't wrap, so a long
    // title scrolls sideways and clips at the column edge. rows={1} +
    // field-sizing-content makes it open as one line and grow downward as the
    // title wraps — the heading-that-wraps pattern (Notion / Obsidian inline
    // title). resize-none + hidden scrollbar keep it reading as a heading, not
    // a form control. Enter still commits (onKeyDown), so it never gains a
    // literal newline.
    <textarea
      ref={inputRef}
      rows={1}
      data-page-title
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      placeholder="Untitled"
      aria-label="Note title"
      // Same visual weight as ReadOnlyHeader so the slot doesn't
      // jump when switching between daily / system / wiki docs.
      // bg-transparent + outline-none makes the field feel like a
      // heading rather than a form control — Notion / Obsidian
      // visual pattern.
      className={cn(
        // leading-[normal] (keyword), not a numeric ratio: a numeric line-height
        // makes WebKit draw the textarea caret at the full line box height.
        'mb-6 w-full resize-none bg-transparent text-3xl font-semibold leading-[normal] text-foreground outline-none placeholder:text-muted-foreground/50',
        'field-sizing-content overflow-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
      )}
    />
  )
}
