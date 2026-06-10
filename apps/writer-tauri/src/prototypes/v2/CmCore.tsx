// Clean rewrite of the CodeMirror live-preview spike, built minimally from the
// CM6 docs (codemirror.net/docs). Reachable at #/dev/cm2.
//
// STEP 0 — the FOUNDATION: a bare editor with NO live-preview decorations. The
// only goal is to confirm that plain typing, the caret, and Korean/CJK IME
// composition feel smooth on a minimal, fully-understood setup BEFORE any
// decoration layer is added. Everything from the old prototype (decorations,
// reveal, cards, IME-freeze hacks, atomic ranges) is intentionally absent and
// will be re-introduced one verified layer at a time.
//
// Deliberately NOT using `basicSetup` — it bundles line numbers + a fold gutter,
// which are wrong for a prose editor. We hand-pick the minimal extension set.

import { useEffect, useRef } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, drawSelection, dropCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { markdown, deleteMarkupBackward } from '@codemirror/lang-markdown'
import { autocompletion } from '@codemirror/autocomplete'
import { GFM } from '@lezer/markdown'
import { cmPrototypeTheme } from '../cmTheme'
import { livePreviewV2, taskCheckboxClick } from './livePreview'
import { blocksV2 } from './blocks'
import { tableArrowEntry } from './editableTable'
import { blockVerticalNav } from './blockVerticalNav'
import { tableBackspace } from './tableBackspace'
import { inlineFormatKeymap } from './inlineFormat'
import { smartEnter } from '../listEnter'
import { imeListContinue } from '../imeListContinue'
import { wikilinkSource } from '../wikilinkComplete'
import { wikilinkClick } from '../wikilinkNav'
import { linkClick } from '../linkNav'
import { arrowDebug } from './ProofRichSpike' // TEMP — arrow-jump instrumentation

// Transient toast — the spike's stand-in for "navigate to note" / "open URL".
function toast(message: string): void {
  const el = document.createElement('div')
  el.textContent = message
  el.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'background:var(--foreground);color:var(--background);padding:8px 14px;' +
    'border-radius:8px;font-size:13px;z-index:9999;opacity:0.95;'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 1500)
}

const SAMPLE = `# Heading one
## Heading two

LIST EDITING (markers stay RAW — no bullets drawn). The point of this step is the
*behavior*, via CM's own markdown commands:
- type \`- \` then text, press ENTER → a new \`- \` continues automatically
- press ENTER on an empty item → it exits the list
- BACKSPACE at an item's start → removes the marker / dedents
- TAB / SHIFT-TAB → indent / outdent (nesting)

Try it here:

- first item (press Enter at the end of this line)
- second item
1. ordered one (Enter continues as 2.)
- [ ] an unchecked task
- [x] a checked task

Does it FEEL like a list to edit, the way the old editor did — even without the •?
(Headings/bold reveal still work; 한글 IME too.)

LINKS & WIKILINKS: a [normal link](https://example.com) shows just the text;
move the caret onto it to reveal the raw markdown, Cmd/Ctrl-click to open. Wikilinks
like [[Project Brasilia]] (known) and [[Nonexistent Note]] (unknown → red) hide the
\`[[ ]]\` when the caret is off; click to navigate. Type \`[[\` for autocomplete.

BLOCK TEXT (new): blockquote, rule, code fence — all line decorations (no widgets,
so no "earthquake"). Move the caret onto each to edit the raw markdown.

> A blockquote sits behind a soft left border, muted and italic.

---

\`\`\`ts
const greet = (name: string) => \`hello, \${name}\`
\`\`\`

IMAGE (widget): the "earthquake" test. Type on the lines ABOVE the image — it
should NOT reload/flash (it's mapped, not rebuilt). Caret onto the image markdown
reveals the raw \`![...](...)\`.

![A scenic placeholder](https://picsum.photos/480/240)

Some text below the image.

TABLE (block widget): renders as a real table with PER-COLUMN ALIGNMENT from the
delimiter row (\`:---\` left, \`:---:\` center, \`---:\` right). Put the caret inside to
edit the raw markdown, move out to re-render. Typing above it must not reload it.

| Feature | PM | CM |
| :--- | :---: | ---: |
| **Anchor** stability | \`100%\` | [docs](https://x.com) |
| Anchor LOC | 724 | ~~724~~ 130 |

MEDIA (block widget, SPIKE: NATIVE webview controls): play/seek/volume use the OS
(WKWebView) player chrome — pressing them must NOT flip the card to raw source.
Arrow a caret onto it to reveal the raw \`<video>\` line ABOVE the player (Obsidian-
style) — select & drag that TEXT to move the block. Type on the lines ABOVE — playback
must NOT reset (map preserves the element).

<video src="https://www.w3schools.com/html/mov_bbb.mp4" controls></video>

<audio src="https://www.w3schools.com/html/horse.mp3" title="Sample audio" controls></audio>
`

export default function CmCore() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SAMPLE,
        extensions: [
          // Minimal editing core (CM docs "getting started") + the markdown LIST
          // editing keymap (CM's own commands): Enter continues a list/quote item
          // (and exits on an empty one), Backspace at item start removes the
          // marker / dedents, Tab indents. This is the "behaves like a list" layer
          // — markers stay raw; rendering is a separate concern.
          history(),
          // Safari/WKWebView drops the Enter that confirms an IME composition, so
          // a Korean list item + Enter wouldn't continue the list. Recover it from
          // the browser's own beforeinput (insertParagraph/insertLineBreak) signal.
          imeListContinue(),
          indentUnit.of('  '), // 2-space nesting
          // ENTER — one deterministic handler at Prec.highest (atomic-editor's
          // pattern): tight list continuation / clean exit, blockquote continuation,
          // else plain newline. Beats every other Enter handler so CM's loose-list
          // (blank-line) inference and its task-continuation deletion never run.
          Prec.highest(
            keymap.of([
              { key: 'Enter', run: smartEnter },
              // Swallow Backspace ONLY on the blank line right below a table (with a
              // paragraph under it) — deleting it would let GFM absorb that paragraph
              // into the table (it vanishes). Keeps the blank; everything else normal.
              { key: 'Backspace', run: tableBackspace },
            ]),
          ),
          // Inline-format shortcuts: ⌘B/⌘I/⌘E/⌘⇧X wrap-toggles + ⌘K link.
          inlineFormatKeymap,
          keymap.of([
            { key: 'Backspace', run: deleteMarkupBackward },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          // CM draws its OWN caret/selection. Needed so the native caret doesn't
          // show as a stray horizontal bar during IME composition (the Korean
          // "가로 커서" artifact). The theme hides the native caret.
          drawSelection(),
          dropCursor(), // drop-position indicator for dragging block widgets
          EditorView.lineWrapping,
          // Parse markdown for the syntax tree only — we render nothing from it
          // yet (no decorations at step 0). addKeymap:false so list/quote Enter
          // continuation isn't wired until we choose to.
          markdown({ extensions: [GFM], addKeymap: false }),
          // `[[` → note-title autocomplete (CM's own autocomplete, same source as
          // the old prototype). Wikilink/link clicks open via a toast stand-in.
          autocompletion({ override: [wikilinkSource], icons: true }),
          wikilinkClick((title) => toast(`→ open note: ${title}`)),
          linkClick((url) => toast(`→ open URL: ${url}`)),
          taskCheckboxClick, // click the drawn checkbox → toggle `[ ]`↔`[x]`
          livePreviewV2, // heading/emphasis/link/wikilink/quote/hr/code (inline+line)
          blocksV2, // image + table + media widgets — StateField + map (no reload above)
          tableArrowEntry, // ArrowDown/Up on the line above/below a table → enter a cell
          blockVerticalNav, // correct ArrowUp/Down overshoot across stacked block widgets
          Prec.highest(arrowDebug), // TEMP — arrow-jump instrumentation, remove after diagnosis
          cmPrototypeTheme,
        ],
      }),
    })
    return () => view.destroy()
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'auto',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      <div
        style={{
          padding: '10px 16px',
          fontSize: 13,
          color: 'var(--muted-foreground)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        CM Core (clean rewrite) — media spike (native webview controls + edit-source reveal)
      </div>
      <div className="cm-prototype" ref={hostRef} />
    </div>
  )
}
