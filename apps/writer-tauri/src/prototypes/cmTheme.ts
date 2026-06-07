// Typography theme for the CM Live Preview spike. Re-maps the app's prose
// tokens (defined in index.css off `.ProseMirror`) onto CodeMirror's
// `.cm-content`/`.cm-line` + our decoration classes, so the prototype
// looks like the real editor under the same ThemeProvider/FontProvider.
// Everything is scoped by EditorView.theme, so it can't leak.

import { EditorView } from '@codemirror/view'

export const cmPrototypeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: 'var(--prose-base, 16px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-sans)',
    lineHeight: 'var(--prose-lh-body, 1.7)',
    overflow: 'visible',
  },
  '.cm-content': {
    maxWidth: '680px',
    margin: '0 auto',
    padding: '48px 24px 120px',
    // Hide the NATIVE caret — drawSelection() renders our own .cm-cursor. Leaving
    // this as a color would show both (a double caret) since the user theme wins
    // over drawSelection's base theme.
    caretColor: 'transparent',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  // Drop-position indicator during drag. CM's default is solid black →
  // invisible on a dark palette; tint it so you can gauge where it'll land.
  '.cm-dropCursor': { borderLeftColor: 'var(--info)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--info) 22%, transparent)',
  },

  // Headings (line decorations)
  '.cm-h1, .cm-h2, .cm-h3, .cm-h4, .cm-h5, .cm-h6': {
    fontWeight: '600',
    lineHeight: 'var(--prose-lh-heading, 1.25)',
  },
  '.cm-h1': { fontSize: 'var(--prose-h1, 28px)' },
  '.cm-h2': { fontSize: 'var(--prose-h2, 22px)' },
  '.cm-h3': { fontSize: 'var(--prose-h3, 18px)' },
  '.cm-h4': { fontSize: 'var(--prose-h4, 16px)' },
  '.cm-h5': {
    fontSize: 'var(--prose-h5, 14px)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  '.cm-h6': {
    fontSize: 'var(--prose-h6, 13px)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--muted-foreground)',
  },

  // Inline marks
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strike': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
    background: 'var(--muted)',
    padding: '0 0.3em',
    borderRadius: '0.25rem',
  },
  '.cm-link': {
    color: 'var(--info)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  '.cm-wikilink': {
    color: 'var(--info)',
    background: 'color-mix(in oklch, var(--info) 12%, transparent)',
    padding: '0 0.3em',
    borderRadius: '0.25em',
  },
  '.cm-wikilink-broken': {
    color: 'var(--destructive, crimson)',
    background: 'color-mix(in oklch, crimson 12%, transparent)',
    padding: '0 0.3em',
    borderRadius: '0.25em',
    textDecoration: 'underline dashed',
    textDecorationColor: 'var(--destructive, crimson)',
  },

  // Highlight (read-it-later) — view-only mark over recorded ranges
  '.cm-highlight': {
    background: 'color-mix(in oklch, gold 38%, transparent)',
    borderRadius: '2px',
    cursor: 'pointer',
  },

  // Blockquote (line decoration)
  '.cm-blockquote': {
    borderLeft: '2px solid var(--border)',
    paddingLeft: '1rem',
    color: 'var(--muted-foreground)',
    fontStyle: 'italic',
  },

  // Horizontal rule (line decoration: border on an emptied line)
  '.cm-hr': {
    borderTop: '1px solid var(--border)',
    height: '0',
    color: 'transparent',
  },

  // Fenced code (line decoration)
  '.cm-code-block': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
    background: 'var(--muted)',
  },

  // List items — canonical CM6 "hanging indent" (see livePreview.ts). The line
  // reserves the content column with `padding-inline-start` (= level*STEP + indent
  // + gutter, set per-line) and pulls ONLY the first visual row back by one gutter
  // with `text-indent: -1.5em`. text-indent applies to the first row only, so
  // wrapped rows stay at the padding edge and align under the CONTENT for free.
  // The marker fills that pulled-back gutter: its glyph is an inline-block ::before
  // sized to exactly one gutter (the ::before carries its own non-zero font-size,
  // so its `em` width is real even though the host span is `font-size:0`). Each
  // marker span resets `text-indent:0` so the line's hang doesn't leak into the
  // glyph. Markers stay IN-FLOW (source text node survives → IME anchor).
  '.cm-list-line': {
    paddingInlineStart: 'var(--cm-list-pad)',
    textIndent: '-1.5em', // pull first row into the gutter (= -LIST_GUTTER)
  },
  '.cm-list-bullet': {
    fontSize: '0', // collapse the source dash; the glyph is ::before
    color: 'transparent',
    textIndent: '0', // don't inherit the line's hanging indent
  },
  '.cm-list-checkbox': {
    fontSize: '0',
    color: 'transparent',
    textIndent: '0',
    cursor: 'pointer',
  },
  // Ordered number stays VISIBLE; a fixed-width gutter box, right-aligned so "1."
  // and "10." line up against the content column (with a small reading gap).
  '.cm-list-num': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '1.5em', // = LIST_GUTTER (font-size is normal here, so `em` is real)
    paddingInlineEnd: '0.35em', // gap between the number and the content
    textIndent: '0',
    textAlign: 'right',
    whiteSpace: 'nowrap',
    color: 'var(--muted-foreground)',
  },
  // Task `- ` dash: collapsed to ~0 width (NO box); the checkbox is the gutter.
  '.cm-list-taskdash': { fontSize: '0', color: 'transparent' },
  // Bullet glyph: inline-block sized to one gutter so the content lands at the
  // column; the • is centered for a balanced gap on both sides.
  '.cm-list-bullet::before': {
    content: '"•"',
    display: 'inline-block',
    width: '1.5em', // = LIST_GUTTER
    fontSize: 'var(--prose-base, 16px)',
    textAlign: 'center',
    color: 'var(--muted-foreground)',
    pointerEvents: 'none',
  },
  // Checkbox box (1em square) + a 0.5em gap = one gutter, so content aligns.
  '.cm-list-checkbox::before': {
    content: '""',
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '1em',
    height: '1em',
    marginInlineEnd: '0.5em', // box(1em) + gap(0.5em) = LIST_GUTTER(1.5em)
    fontSize: 'var(--prose-base, 16px)',
    lineHeight: '1em',
    textAlign: 'center',
    verticalAlign: '-0.15em',
    border: '1.5px solid var(--muted-foreground)',
    borderRadius: '0.4em',
    color: '#fff',
  },
  '.cm-list-checkbox-checked::before': {
    content: '"✓"',
    background: 'var(--info)',
    borderColor: 'var(--info)',
  },

  // Image widget
  '.cm-img': {
    display: 'inline-block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '8px',
    verticalAlign: 'bottom',
  },
  // Completed task: strike + dim the item text (Ixora's cm-task-checked).
  '.cm-task-checked': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
  },

  // Table widget
  '.cm-md-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '0.92em',
    margin: 'var(--prose-gap-block, 14px) 0',
  },
  '.cm-md-table th, .cm-md-table td': {
    border: '1px solid var(--border)',
    padding: '0.35em 0.6em',
    textAlign: 'left',
  },
  '.cm-md-table th': {
    background: 'color-mix(in oklch, var(--muted) 60%, transparent)',
    fontWeight: '600',
  },
})
