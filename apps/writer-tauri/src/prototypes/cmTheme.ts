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
    caretColor: 'var(--foreground)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
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

  // Bullet widget
  '.cm-bullet': { color: 'var(--muted-foreground)' },

  // Image widget
  '.cm-img': {
    display: 'inline-block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '8px',
    verticalAlign: 'bottom',
  },

  // Checkbox widget
  '.cm-checkbox': {
    width: '1em',
    height: '1em',
    marginRight: '0.4em',
    verticalAlign: '-0.1em',
    accentColor: 'var(--primary)',
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
