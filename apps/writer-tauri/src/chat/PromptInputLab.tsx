// Gallery sandbox for the chat composer.
//
// Step 1 (this file): render the REAL <PromptInput> inside the design
// gallery with a self-contained mock harness — enough to prove the
// composer works outside ChatPanel (its stores are global zustand, so
// they hydrate to empty state; only the props need mocking). The last
// submitted payload is echoed below so attach / send / mention are
// visibly exercised.
//
// This is the validation baseline BEFORE forking the composer toward an
// inline-chip rich editor (the B2 exploration). Once this renders, the
// fork lives next to it here and swaps only the <textarea> internals.

import { useRef, useState } from 'react'
import { PromptInput, type PromptStatus } from '@/chat/PromptInput'
import { RichTextArea, type RichTextAreaHandle, type ChipData } from '@/chat/RichTextArea'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { IconPaperclip } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { DEFAULT_MODEL } from '@/agent/chat/types'
import type {
  ChatEffort,
  ChatMode,
  ChatModel,
  FileAttachment,
} from '@/chat/types'

interface LastSend {
  text: string
  attachments: FileAttachment[]
  mentionPaths: string[]
}

export function ComposerLab() {
  const [status, setStatus] = useState<PromptStatus>('idle')
  const [model, setModel] = useState<ChatModel>(DEFAULT_MODEL as ChatModel)
  const [effort, setEffort] = useState<ChatEffort>('medium')
  const [mode, setMode] = useState<ChatMode>('edit')
  const [fastMode, setFastMode] = useState(false)
  const [last, setLast] = useState<LastSend | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <PromptInput
        threadId="gallery-lab"
        status={status}
        placeholder="Composer sandbox — type, attach, @mention…"
        onSubmit={(text, attachments, mentionPaths) => {
          setLast({ text, attachments, mentionPaths })
          // Simulate a short in-flight turn so the Stop button is exercised.
          setStatus('streaming')
          window.setTimeout(() => setStatus('idle'), 900)
        }}
        onStop={() => setStatus('idle')}
        model={model}
        onModelChange={setModel}
        effort={effort}
        onEffortChange={setEffort}
        mode={mode}
        onModeChange={setMode}
        fastMode={fastMode}
        onFastModeChange={setFastMode}
      />

      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 p-3 text-footnote">
        <div className="mb-1 font-medium text-muted-foreground">Last submit</div>
        {last ? (
          <pre className="whitespace-pre-wrap break-words text-foreground/80">
            {JSON.stringify(
              {
                text: last.text,
                attachments: last.attachments.map((a) => ({
                  name: a.name,
                  mediaType: a.mediaType,
                  path: a.path,
                })),
                mentionPaths: last.mentionPaths,
              },
              null,
              2,
            )}
          </pre>
        ) : (
          <span className="text-muted-foreground">Nothing sent yet.</span>
        )}
      </div>

      <div className="my-2 border-t border-border/60" />
      <RichComposerLab />

      <div className="my-2 border-t border-border/60" />
      <TextParityLab />

      <div className="my-2 border-t border-border/60" />
      <InlineChipLab />

      <div className="my-2 border-t border-border/60" />
      <PaletteLab />
    </div>
  )
}

// ── Phase 3 · slash / mention palettes on contenteditable ─────────────
// Same regexes as prod PromptInput, but run on RichTextArea's text-before-caret
// (via onCaretContext) instead of textarea.value. Slash pick → setText; mention
// pick → replaceBeforeCaretWithChip (inline mention chip). Nav keys are claimed
// through the onKeyDown passthrough before the editor's Enter=submit.
const LAB_SLASH_RE = /^\/([a-z][a-z0-9-]*)?$/
const LAB_AT_RE = /(?:^|\s)@([^\s@]*)$/
const LAB_COMMANDS = ['organize', 'daily-ingest', 'summarize', 'chat-to-wiki']
const LAB_NOTES = [
  { title: 'Project Atlas', path: 'wiki/Project Atlas.md' },
  { title: 'Meeting 2026-07-14', path: 'daily/2026-07-14.md' },
  { title: 'Reading list', path: 'inbox/Reading list.md' },
]

function PaletteLab() {
  const ref = useRef<RichTextAreaHandle>(null)
  const chipSeq = useRef(0)
  const [before, setBefore] = useState('')
  const [caretRect, setCaretRect] = useState<DOMRect | null>(null)
  const [idx, setIdx] = useState(0)
  const [out, setOut] = useState<{ text: string; chips: ChipData[] } | null>(null)

  const slashMatch = LAB_SLASH_RE.exec(before)
  const atMatch = LAB_AT_RE.exec(before)
  const slashOpen = slashMatch !== null
  const mentionOpen = atMatch !== null && !slashOpen

  const commands = slashOpen
    ? LAB_COMMANDS.filter((c) => c.startsWith(slashMatch![1] ?? ''))
    : []
  const notes = mentionOpen
    ? LAB_NOTES.filter((n) =>
        n.title.toLowerCase().includes((atMatch![1] ?? '').toLowerCase()),
      )
    : []
  const list: string[] = slashOpen ? commands : notes.map((n) => n.title)
  const safeIdx = list.length === 0 ? 0 : Math.min(idx, list.length - 1)
  const paletteOpen = (slashOpen || mentionOpen) && list.length > 0

  function pickSlash(name: string) {
    ref.current?.setText(`/${name} `)
    setIdx(0)
  }
  function pickNote(note: { title: string; path: string }) {
    chipSeq.current += 1
    ref.current?.replaceBeforeCaretWithChip((atMatch![1] ?? '').length + 1, {
      id: `mention-${chipSeq.current}`,
      kind: 'mention',
      label: note.title,
      value: note.path,
    })
    setIdx(0)
  }

  // Claim palette-nav keys before the editor's Enter=submit.
  function onEditorKeyDown(e: React.KeyboardEvent<HTMLDivElement>): boolean {
    if ((!slashOpen && !mentionOpen) || list.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => (i + 1) % list.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => (i - 1 + list.length) % list.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (e.nativeEvent.isComposing) return false
      e.preventDefault()
      if (slashOpen) pickSlash(commands[safeIdx])
      else pickNote(notes[safeIdx])
      return true
    }
    return false
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-footnote text-muted-foreground">
        Phase 3 · palettes — type <code>/</code> (command) or <code>@</code>{' '}
        (note). ↑↓ to move, Enter/Tab to pick. Slash → text, mention → inline chip.
      </div>

      <div className="rounded-3xl border-[0.5px] border-border bg-muted p-2.5">
        {/* Caret-following palette, done the canonical way: a 0-size virtual
            anchor pinned to the caret rect + a Radix Popover that positions
            itself (flip/shift for free). onOpenAutoFocus is prevented so focus
            stays in the editor — nav still comes through onEditorKeyDown. */}
        <Popover open={paletteOpen} onOpenChange={() => {}}>
          {caretRect && (
            <PopoverAnchor asChild>
              <span
                aria-hidden
                style={{
                  position: 'fixed',
                  left: caretRect.left,
                  top: caretRect.top,
                  width: 0,
                  height: caretRect.height,
                }}
              />
            </PopoverAnchor>
          )}
          <PopoverContent
            side="top"
            align="start"
            sideOffset={6}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            className="w-56 gap-0 p-1"
          >
            {list.map((label, i) => (
              <button
                key={label}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setIdx(i)}
                onClick={() => (slashOpen ? pickSlash(commands[i]) : pickNote(notes[i]))}
                className={cn(
                  'block w-full rounded-md px-2.5 py-1.5 text-left text-footnote',
                  i === safeIdx ? 'bg-accent text-foreground' : 'text-muted-foreground',
                )}
              >
                {slashOpen ? `/${label}` : `@ ${label}`}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <RichTextArea
          ref={ref}
          placeholder="Type / or @ …"
          onCaretContext={(ctx) => {
            setBefore(ctx.before)
            setCaretRect(ctx.rect)
          }}
          onKeyDown={onEditorKeyDown}
        />
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 p-3 text-footnote">
        <div className="mb-1 font-medium text-muted-foreground">
          before-caret: <span className="text-foreground/60">{JSON.stringify(before)}</span>
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            setOut({ text: ref.current?.getText() ?? '', chips: ref.current?.getChips() ?? [] })
          }
          className="mb-1 rounded-full px-2 py-1 text-footnote text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Read content
        </button>
        {out && (
          <pre className="whitespace-pre-wrap break-words text-foreground/80">
            {JSON.stringify(
              { text: out.text, mentionPaths: out.chips.map((c) => c.value) },
              null,
              2,
            )}
          </pre>
        )}
      </div>
    </div>
  )
}

// ── Phase 2 · inline attachment chips ─────────────────────────────────
// Chips live INSIDE the text now (RichTextArea.insertChip). "Read content"
// serializes to { text (chips excluded), chips (paths, in order) } — exactly
// the { text, attachmentPaths } a real submit will need.
function InlineChipLab() {
  const ref = useRef<RichTextAreaHandle>(null)
  const chipSeq = useRef(0)
  const [out, setOut] = useState<{ text: string; chips: ChipData[] } | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <div className="text-footnote text-muted-foreground">
        Phase 2 · inline chips — put the caret mid-sentence, insert a chip, keep
        typing. Backspace deletes a chip whole. Caret must NOT grow.
      </div>

      <div className="rounded-3xl border-[0.5px] border-border bg-muted p-2.5">
        <RichTextArea ref={ref} placeholder="Type, then drop a chip mid-sentence…" />
        <div className="flex items-center gap-2 px-1 pt-1">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              chipSeq.current += 1
              const n = chipSeq.current
              ref.current?.insertChip({
                id: `lab-${n}`,
                kind: 'file',
                label: `Screenshot-${n}.png`,
                value: `.octave/attachments/lab-${n}/Screenshot-${n}.png`,
              })
            }}
            className="rounded-full px-2 py-1 text-footnote text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            🖼 Insert file chip
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              setOut({ text: ref.current?.getText() ?? '', chips: ref.current?.getChips() ?? [] })
            }
            className="rounded-full px-2 py-1 text-footnote text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Read content
          </button>
        </div>
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 p-3 text-footnote">
        <div className="mb-1 font-medium text-muted-foreground">Serialized</div>
        {out ? (
          <pre className="whitespace-pre-wrap break-words text-foreground/80">
            {JSON.stringify(
              { text: out.text, attachmentPaths: out.chips.map((c) => c.value) },
              null,
              2,
            )}
          </pre>
        ) : (
          <span className="text-muted-foreground">Press “Read content”.</span>
        )}
      </div>
    </div>
  )
}

// ── Phase 1 · text parity ─────────────────────────────────────────────
// Exercises RichTextArea as a full drop-in for the <textarea>: typing (한글),
// Enter=submit, Shift+Enter=newline, paste-strips-formatting, placeholder,
// auto-grow, stable caret. No chips yet — that's Phase 2.
function TextParityLab() {
  const ref = useRef<RichTextAreaHandle>(null)
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <div className="text-footnote text-muted-foreground">
        Phase 1 · text parity — 한글 OK · Enter=submit · Shift+Enter=newline ·
        paste strips formatting.
      </div>

      <div className="rounded-3xl border-[0.5px] border-border bg-muted p-2.5">
        <RichTextArea
          ref={ref}
          placeholder="Ask anything…  (Enter 전송 · Shift+Enter 줄바꿈)"
          onChange={setText}
          onSubmit={() => {
            setSubmitted(ref.current?.getText() ?? '')
            ref.current?.clear()
          }}
        />
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 p-3 text-footnote">
        <div className="mb-1 font-medium text-muted-foreground">Live text · {text.length} chars</div>
        <pre className="whitespace-pre-wrap break-words text-foreground/80">{text || '—'}</pre>
        <div className="mb-1 mt-3 font-medium text-muted-foreground">Last submit</div>
        <pre className="whitespace-pre-wrap break-words text-foreground/80">{submitted ?? '—'}</pre>
      </div>
    </div>
  )
}

// ── B2 core-risk probe ────────────────────────────────────────────────
// The single question that decides whether inline chips are viable:
// can a contenteditable hold TEXT + an inline non-editable CHIP while
// Korean IME composition still works? The trick is to keep the editor
// UNCONTROLLED — React must never rewrite its innerHTML after mount, or
// every keystroke resets the caret and breaks composition. State (the
// chips, the serialized value) is read from the DOM on demand, never
// pushed back in. Chip insertion is direct DOM mutation at the caret.
//
// Serialization walks child nodes: text nodes → their text, chip spans →
// a `[file:<name>]` token. That token is what a real fork would map back
// to an attachment path.
function serializeEditor(root: HTMLElement): string {
  let out = ''
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
    } else if (node instanceof HTMLElement && node.dataset.chip) {
      out += `[file:${node.dataset.chip}]`
    } else if (node instanceof HTMLElement) {
      out += node.textContent ?? ''
    }
  })
  return out
}

export function RichComposerLab() {
  const editorRef = useRef<HTMLDivElement>(null)
  const [serialized, setSerialized] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const chipCount = useRef(0)

  function insertChip() {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    // Guard: only insert if the caret is actually inside the editor.
    if (!editor.contains(range.commonAncestorContainer)) return
    range.deleteContents()

    chipCount.current += 1
    const name = `Screenshot-${chipCount.current}.png`
    const chip = document.createElement('span')
    chip.contentEditable = 'false'
    chip.dataset.chip = name
    // Height MUST stay below the editor's line-height strut, or this atomic
    // inline box (inline-flex) grows the line box → taller caret. leading-none
    // pins content to 13px, py-[2px] → ~17px total, safely under the ~22px
    // strut. align-middle centers it without pushing the line.
    chip.className =
      'mx-0.5 inline-flex select-none items-center gap-1 rounded-md bg-accent px-1.5 py-[2px] align-middle text-[13px] leading-none text-foreground'
    chip.textContent = `🖼 ${name}`
    range.insertNode(chip)

    // Caret after the chip, with a trailing space so the user can keep typing.
    const space = document.createTextNode(' ')
    chip.after(space)
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-footnote text-muted-foreground">
        Prototype · contenteditable + inline chip + Korean IME probe (uncontrolled;
        React never rewrites its content).
      </div>

      <div
        className="relative flex flex-col gap-1.5 rounded-3xl border-[0.5px] border-border bg-muted p-2.5"
      >
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          data-placeholder="Type here — 한글도 쳐보세요. Insert a chip mid-sentence."
          className={cn(
            // Fixed line-height (strut ~22px @15px) gives the inline chip a
            // box it fits inside, so a chip never grows the line box / caret.
            'min-h-28 w-full resize-none bg-transparent px-2.5 py-1.5 text-[15px] leading-[1.5] text-foreground outline-none',
            'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          )}
        />
        <div className="flex items-center gap-2 px-1">
          <button
            type="button"
            // preventDefault on mousedown keeps the editor's selection/focus
            // so the chip lands at the caret, not at the end.
            onMouseDown={(e) => e.preventDefault()}
            onClick={insertChip}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-footnote text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <IconPaperclip size={15} stroke={1.5} /> Insert chip
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (editorRef.current) setSerialized(serializeEditor(editorRef.current))
            }}
            className="rounded-full px-2 py-1 text-footnote text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Read content
          </button>
          <span className="ml-auto text-footnote text-muted-foreground">
            {composing ? 'composing…' : 'idle'}
          </span>
        </div>
      </div>

      <div className="rounded-lg border-[0.5px] border-border bg-muted/40 p-3 text-footnote">
        <div className="mb-1 font-medium text-muted-foreground">Serialized</div>
        {serialized !== null ? (
          <pre className="whitespace-pre-wrap break-words text-foreground/80">{serialized}</pre>
        ) : (
          <span className="text-muted-foreground">Press “Read content”.</span>
        )}
      </div>
    </div>
  )
}
