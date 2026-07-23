// Pure factory for the CmEditor extension stack. Extracted from CmEditor's mount
// effect so the ORDER of the 39 extensions is captured in one place and can be
// asserted headlessly (see buildExtensions.test.ts). The array below is a verbatim
// cut of what used to live in EditorState.create({ extensions: [ ... ] }); the
// ordering comments are load-bearing (keymap precedence + IME correctness) — do NOT
// reorder. Only `slug` and `scheduleStats` are parameterized.

import { EditorState, Prec, Annotation, Transaction, type ChangeSpec, type Extension, type TransactionSpec } from '@codemirror/state'
import { diffLines } from 'diff'
import { EditorView, keymap, drawSelection, dropCursor, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches } from '@codemirror/search'
import { indentUnit } from '@codemirror/language'
import { markdown, deleteMarkupBackward, pasteURLAsLink } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { useEditorSelectionStore } from '@/state/editorSelectionStore'
import { markSlugDirty } from '@/lib/docFileSync'
import { cmPrototypeTheme } from '@/editor/theme/cmTheme'
import { livePreviewV2, taskCheckboxClick, wikilinkKnown } from '@/editor/livepreview/livePreview'
import { blocksV2 } from '@/editor/livepreview/blocks'
import { tableArrowEntry } from '@/editor/livepreview/editableTable'
import { blockVerticalNav } from '@/editor/extensions/blockVerticalNav'
import { inlineFormatKeymapNoLink } from '@/editor/extensions/inlineFormat'
import { wikilinkClick } from '@/editor/extensions/wikilinkNav'
import { linkClick } from '@/editor/extensions/linkNav'
import { timestampSeekClick } from '@/editor/cmTimestampSeek'
import { youtubeCards } from '@/editor/cards/youtubeCards'
import { mermaidCards } from '@/editor/cards/mermaidCards'
import { navigateToNoteByTitle, isKnownNoteTitle } from '@/editor/cmNav'
import { cmInBufferReview, shouldRemirror } from '@/editor/cmInBufferReview'
import { openLinkSafely } from '@/editor/linkUtils'
import { slashMenu, slashKeymap } from '@/editor/slashMenu'
import { wikilinkMenu, wikilinkKeymap } from '@/editor/wikilinkMenu'
import { smartEnter, shiftEnter } from '@/editor/extensions/listEnter'
import { imeListContinue } from '@/editor/extensions/imeListContinue'
import { spaceWidthProbe } from '@/editor/extensions/spaceWidth'
import { dedentContinuationBackward } from '@/editor/extensions/listBackspace'
import { mediaDropPaste } from '@/editor/extensions/mediaDrop'
import { richTextCopy } from './cmRichCopy'
import { htmlPaste } from './cmHtmlPaste'
import { importMediaToVault } from '@/editor/cmMedia'
import { pageHeaderWidget } from '@/editor/cmPageHeaderWidget'

// CM now OWNS the scroll (.cm-scroller, overflow:auto), so the centered 750px column
// + vertical breathing room live HERE on .cm-content and scroll with the content —
// they used to be on an outer React div that owned scrolling (which broke CM's
// viewport virtualization → the fast-scroll blank-flash). `textAlign: justify`
// flushes prose to both edges; `hyphens: auto` lets the engine break long words so it
// doesn't open large inter-word gaps ("rivers") on the narrow column. WKWebView
// (macOS) needs the -webkit- prefix, and hyphenation only fires when a `lang` is set
// on the content (see EditorView.contentAttributes below). Korean is unaffected (CJK
// breaks per-character), so this mainly cleans up English prose.
const layoutReset = EditorView.theme({
  // Alignment + hyphenation read from CSS vars set on the React wrapper, so the
  // Settings toggle changes them live without a Compartment reconfigure. This rule
  // wins over cmPrototypeTheme's leaking `.cm-content` rule on source order; the
  // nested-cell reset (`.cm-celledit .cm-content`) is more specific and still beats
  // the 750px column, so table cells stay full-width.
  '.cm-content': {
    maxWidth: '750px',
    margin: '0 auto',
    // Top inset clears the window chrome (EditorHeader, --header-h). The title widget
    // is the first thing inside .cm-content, so this is what keeps it below the chrome
    // at scroll-top; as you scroll, the title passes UNDER the chrome + glass band.
    padding: 'calc(var(--header-h) + 1.5rem) 32px 4rem',
    textAlign: 'var(--cm-text-align, justify)',
    WebkitHyphens: 'var(--cm-hyphens, auto)',
    hyphens: 'var(--cm-hyphens, auto)',
  },
})

// Tags a programmatic whole-body replace (external reload / background rewrite) so the
// dirty-tracking update listener ignores it — it's a load FROM disk, not a user edit.
// Defined here (not in CmEditor) because it's read on BOTH sides: the save listener
// below and CmEditor's registerCmEditor setBody closure, which imports it.
export const externalBody = Annotation.define<boolean>()

// A MINIMAL change set turning the current doc into `md` — a line diff (same `diff`
// primitive as cmHunks), NOT a whole-doc replace. Only the lines that actually differ
// are touched, so: the caret/selection and scroll survive an external edit elsewhere
// (a whole-doc replace collapses every position); unchanged marks/decorations keep
// their positions; and the history stays sane — an intervening reload no longer maps a
// user's own edit on an untouched line into a degenerate change (that's what made a
// post-reload Cmd-Z unreachable). An echo reload (`md` equals the doc) yields NO
// changes. Ranges come out ascending and non-overlapping (CM's requirement).
function minimalReloadChanges(current: string, md: string): ChangeSpec[] {
  if (current === md) return []
  const parts = diffLines(current, md)
  const changes: ChangeSpec[] = []
  let pos = 0 // running offset into `current`
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part.added && !part.removed) {
      pos += part.value.length
      continue
    }
    if (part.removed) {
      const removedLen = part.value.length
      const next = parts[i + 1]
      const insert = next?.added ? (i++, next.value) : ''
      changes.push({ from: pos, to: pos + removedLen, insert })
      pos += removedLen
    } else {
      changes.push({ from: pos, to: pos, insert: part.value }) // pure insertion
    }
  }
  return changes
}

// The transaction spec for an EXTERNAL reload (vault-watcher change / background
// rewrite pushed in via the docsStore body path) — NOT the accept path, which stays
// undoable via acceptEffect. Two annotations, both load-bearing:
//   • externalBody   → the save listener skips it (a load from disk isn't a user edit).
//   • addToHistory:false → it must NOT enter the undo history. Otherwise Cmd-Z reverts
//     the buffer to the PRE-reload text, and that undo transaction (annotations are per
//     transaction, not inherited by their inverses) carries neither annotation → it
//     re-dirties the slug and the flush writes the stale body back over the external
//     edit. Silent data loss. Keeping the reload out of history closes that path.
export function externalReloadSpec(state: EditorState, md: string): TransactionSpec {
  return {
    changes: minimalReloadChanges(state.doc.toString(), md),
    annotations: [externalBody.of(true), Transaction.addToHistory.of(false)],
  }
}

export function buildEditorExtensions(deps: {
  slug: string
  scheduleStats: (state: EditorState) => void
}): Extension[] {
  const { slug, scheduleStats } = deps
  return [
    history(),
    // Measure the body font's space advance → `--cm-space-w`, so list
    // continuation hanging-indent can pull leading spaces back by their exact
    // width (not a guess). Must precede livePreviewV2, which reads the variable.
    spaceWidthProbe(),
    // Safari/WKWebView drops the Enter that confirms an IME composition, so a
    // Korean list item + Enter wouldn't continue the list. Recover it from the
    // browser's own beforeinput (insertParagraph/insertLineBreak) signal.
    imeListContinue(),
    indentUnit.of('  '),
    // `/` block menu: state + our React tooltip. `slashKeymap` (also
    // Prec.highest) MUST precede smartEnter so it can claim Enter/↑/↓
    // while the menu is open; it returns false when closed, so smartEnter
    // and cursor movement stay intact.
    slashMenu,
    slashKeymap,
    // `[[` wikilink picker: same owned-tooltip design as the `/` menu.
    // `wikilinkKeymap` (Prec.highest) MUST precede smartEnter so it can
    // claim Enter/Tab/↑/↓ while the menu is open; it returns false when
    // closed, so smartEnter and cursor movement stay intact.
    wikilinkMenu,
    wikilinkKeymap,
    // ENTER — one deterministic handler at Prec.highest: tight list continuation
    // / clean exit, blockquote continuation, else plain newline. Must beat every
    // other Enter handler so CM's loose-list inference never runs.
    // SHIFT-ENTER — continue the same list item on an INDENTED new line (real
    // continuation, not a flush-left lazy one); returns false off a list so the
    // default soft newline stands. Highest prec so it beats defaultKeymap's.
    Prec.highest(
      keymap.of([
        { key: 'Enter', run: smartEnter },
        { key: 'Shift-Enter', run: shiftEnter },
      ]),
    ),
    // ⌘B/⌘I/⌘E/⌘⇧X wrap toggles (Prec.high → beats defaultKeymap). ⌘K
    // (link) is intentionally omitted: it opens the command palette.
    inlineFormatKeymapNoLink,
    keymap.of([
      // Indented, marker-less list continuation (Shift+Enter's output) → one
      // press clears the whole indent to leave the item. Before deleteMarkupBackward,
      // which handles markers (incl. a clean column-0 delete on lang-markdown 6.5).
      { key: 'Backspace', run: dedentContinuationBackward },
      { key: 'Backspace', run: deleteMarkupBackward },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    // `lang` is required for `hyphens: auto` (layoutReset) to fire. Set 'en'
    // so English prose hyphenates under justify; CJK is unaffected.
    EditorView.contentAttributes.of({ lang: 'en' }),
    markdown({ extensions: [GFM], addKeymap: false }),
    placeholder('Start writing…'),
    // Highlight other occurrences of the selected text (stock @codemirror/search).
    // minSelectionLength 2 so a single-char selection doesn't flood the viewport;
    // viewport-scoped + plain mark decoration → cheap and IME-safe.
    highlightSelectionMatches({ minSelectionLength: 2 }),
    taskCheckboxClick,
    // Note title + properties as a block widget at doc top → scrolls away
    // with the body, inside CM's scroller (Obsidian inline-title pattern).
    pageHeaderWidget(slug),
    livePreviewV2,
    blocksV2,
    youtubeCards, // a bare youtube URL line → inline player
    mermaidCards, // ```mermaid fence → live diagram (portable across md apps)
    // Mirror the live selection into the editor-agnostic store so the
    // chat panel can show the selection chip + inject it as context.
    // We publish the line range too (CM knows it cheaply) so the chip
    // can read "Note · L10–14" rather than a raw text snippet.
    EditorView.updateListener.of((u) => {
      if (!u.selectionSet && !u.docChanged) return
      const m = u.state.selection.main
      const store = useEditorSelectionStore.getState()
      if (m.empty) {
        store.setSelection(null)
        return
      }
      store.setSelection({
        text: u.state.sliceDoc(m.from, m.to),
        fromLine: u.state.doc.lineAt(m.from).number,
        toLine: u.state.doc.lineAt(m.to).number,
      })
    }),
    tableArrowEntry,
    blockVerticalNav,
    wikilinkKnown.of(isKnownNoteTitle), // blue vs red from REAL knownDocs
    wikilinkClick(navigateToNoteByTitle), // click [[Title]] → open that note
    timestampSeekClick, // plain-click a YouTube timestamp → seek the embed
    linkClick(openLinkSafely), // Cmd/Ctrl-click [text](url) → open (safe schemes)
    mediaDropPaste(importMediaToVault), // drop/paste media → vault + insert
    htmlPaste, // paste rich web HTML → markdown (after media: files win)
    // Paste a URL over a non-empty selection → `[selection](url)`. Stock
    // lang-markdown; disjoint from htmlPaste (it reads text/plain only and
    // wraps, else returns false) so it slots in after it.
    pasteURLAsLink,
    richTextCopy, // Cmd+C/X → clipboard carries html + markdown
    cmInBufferReview(slug), // AI suggestions → in-buffer red/green (Option B)
    // Save: mirror the doc text into the handle cache + flag dirty. The flush
    // loop (serializeDocToFiles → handle.bodyMarkdown) does the rest. A
    // programmatic body set (externalBody) is a load from disk — don't dirty
    // it.
    EditorView.updateListener.of((u) => {
      // Re-mirror on doc changes AND on accept/reject decisions. Accepting
      // a pure-insertion proposal (an append: empty red range) produces NO
      // doc change, yet it flips that text from pending-green (EXCLUDED from
      // greenRangesForSave) to accepted (INCLUDED). Bailing on !docChanged
      // there leaves bodyMarkdown holding the pre-accept body, so an
      // auto-accepted append to the open note is silently dropped on flush.
      // A decision transaction changes the exclusion set → must re-mirror.
      if (!shouldRemirror(u.docChanged, u.transactions)) return
      // Publish live word/char counts (display-only, debounced — no toString
      // on the keystroke). Also fires for programmatic loads.
      scheduleStats(u.state)
      // A programmatic body set (externalBody) is a load FROM disk, not a user
      // edit — don't dirty it.
      if (u.transactions.some((t) => t.annotation(externalBody))) return
      // Just flag the slug dirty. The flush PULLS the current body from this
      // live editor (getBody, below) — CM's state is the source of truth, read
      // on demand rather than mirrored on every keystroke. A decision tx
      // (accept/reject, possibly no doc change) also reaches here → the pull
      // re-reads with the current green set, so an auto-accepted append isn't
      // dropped.
      markSlugDirty(slug)
    }),
    Prec.lowest(cmPrototypeTheme),
    layoutReset,
  ]
}
