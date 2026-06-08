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

  // List bullet (v2 step 1) — Ixora's trick: hide the source dash with
  // `visibility:hidden` (keeps its box → same width, full caret height) and draw
  // a • over it with an absolutely-positioned ::after. Because the geometry is
  // identical to the raw dash, toggling this on/off never reflows (no caret lag).
  '.cm-list-bullet': {
    position: 'relative',
    visibility: 'hidden',
  },
  '.cm-list-bullet::after': {
    content: '"•"',
    visibility: 'visible',
    position: 'absolute',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--muted-foreground)',
  },
  // Ordered number (v2 step 3) — the digits ARE the glyph, so just tint them
  // (no hiding). Same text raw or styled → no geometry change on reveal.
  '.cm-list-num': {
    color: 'var(--muted-foreground)',
  },

  // Image widget
  '.cm-img': {
    display: 'inline-block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '8px',
    verticalAlign: 'bottom',
  },
  // Block "selected" border (click-to-select). `outline` so it doesn't shift the
  // layout (no reflow), like a node selection.
  '.cm-block-selected': {
    outline: '2px solid var(--info)',
    outlineOffset: '2px',
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
