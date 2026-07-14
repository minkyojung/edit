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
