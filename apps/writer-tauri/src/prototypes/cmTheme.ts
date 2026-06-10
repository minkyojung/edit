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
  // ── Nested cell-editor reset ────────────────────────────────────────────────
  // An in-place table cell hosts its OWN nested editor. CM theme selectors are
  // descendant-scoped (`.theme .cm-content`), so this PAGE theme's rules leak into
  // every nested cell. Most leaks are desirable (the cell reuses our mark/link
  // styling), but the PAGE-LAYOUT props are not — a cell is not a page. Neutralize
  // exactly those here, in ONE place, scoped under `.cm-celledit` so the rule is
  // more specific than the leaking `.cm-content` rule and reliably wins. If the page
  // theme later adds page-layout props, reset them here too.
  '.cm-celledit .cm-content': {
    maxWidth: 'none', // ← page: 680px
    margin: '0', // ← page: 0 auto
    padding: '0.3em 0.55em', // ← page: 48px 24px 120px
    minHeight: '1.4em',
  },
  '.cm-celledit .cm-scroller': {
    lineHeight: '1.5', // ← page: 1.7
  },
  // Make the cell's nested editor FILL the cell (the cell can be taller than its own
  // text when another cell in the row is multi-line). Then clicking anywhere in the
  // cell — not just on the text — lands on the editor and focuses it. `height:100%`
  // resolves against the table cell's used height.
  '.cm-celledit .cm-editor': { height: '100%' },
  // ── Proof block-suggestion preview reset ────────────────────────────────────
  // Same story as the cell reset above: the preview tile hosts a nested read-only
  // editor (renderMarkdownReadonly) and must not inherit the PAGE-LAYOUT padding —
  // 48px/120px of dead space dwarfed the previewed table. The extra `.cm-proof-
  // preview` class out-specifies both the leaking page rule and the nested editor's
  // own theme instance. Inner table-wrap spacing is also page-scale; tighten it.
  '.cm-proof-preview .cm-content': {
    maxWidth: 'none',
    margin: '0',
    padding: '0',
  },
  '.cm-proof-preview .cm-table-wrap': {
    padding: '0',
  },
  // Flush preview: the tile's own border doubles as the table's OUTER border, so
  // hide the edge cells' outward-facing lines (borders are per-cell under
  // border-collapse). Inner grid lines stay.
  '.cm-proof-preview .cm-md-table tr > :first-child': { borderLeft: 'none' },
  '.cm-proof-preview .cm-md-table tr > :last-child': { borderRight: 'none' },
  '.cm-proof-preview .cm-md-table thead tr:first-child th': { borderTop: 'none' },
  '.cm-proof-preview .cm-md-table tbody tr:last-child td': { borderBottom: 'none' },
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
  // Wikilink — Obsidian style: underlined coloured TEXT (no pill/background), so
  // it reads as a link and revealing the `[[ ]]` brackets adds no padding gap.
  '.cm-wikilink': {
    color: 'var(--info)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  '.cm-wikilink-broken': {
    color: 'var(--destructive, crimson)',
    textDecoration: 'underline dashed',
    textDecorationColor: 'var(--destructive, crimson)',
    textUnderlineOffset: '2px',
    cursor: 'pointer',
  },
  // The `[[ ]]` brackets while editing — shown but muted (Obsidian dims them).
  '.cm-wikilink-bracket': {
    color: 'var(--muted-foreground)',
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

  // Shared marker column (v2 step 6 — list indent unification). Every list marker
  // (bullet / number / task) is an inline-block of one fixed width, so all body
  // text starts at the same x and wrapped lines hang under it (the line's
  // padding-left/text-indent reserve the column). WIDTH MUST MATCH `LIST_INDENT`
  // in livePreview.ts. text-align:right keeps the glyph next to the body (the
  // empty space falls on the indent side).
  '.cm-list-marker': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '1.8em',
    textAlign: 'right',
    position: 'relative',
  },
  // List bullet (v2 step 1) — Ixora's trick: hide the source dash with
  // `visibility:hidden` (keeps its box → full caret height) and draw a • over it
  // with an absolutely-positioned ::after. Geometry never changes on reveal → no
  // reflow. The • sits at the right of the marker column, beside the body.
  '.cm-list-bullet': {
    visibility: 'hidden',
  },
  '.cm-list-bullet::after': {
    content: '"•"',
    visibility: 'visible',
    position: 'absolute',
    right: '0.32em',
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'var(--muted-foreground)',
  },
  // Ordered number (v2 step 3) — the digits ARE the glyph, so just tint them
  // (right-aligned in the column, next to the body).
  '.cm-list-num': {
    color: 'var(--muted-foreground)',
  },
  // Completed task body — struck through and muted (v2 step 5c).
  '.cm-task-done': {
    textDecoration: 'line-through',
    color: 'var(--muted-foreground)',
  },
  // Task checkbox (v2 step 5) — OVERLAY: keep the `- [ ]` source but
  // visibility:hidden and draw the box with a position:absolute ::after (out of
  // flow → no reflow, no paint lag). The fixed `.cm-list-marker` column pins the
  // box at the right edge regardless of `[ ]` vs `[x]` width.
  '.cm-task-marker': {
    visibility: 'hidden',
  },
  '.cm-task-marker::after': {
    content: '""',
    visibility: 'visible',
    position: 'absolute',
    right: '0.15em',
    top: '50%',
    transform: 'translateY(-50%)',
    boxSizing: 'border-box',
    width: '1.05em',
    height: '1.05em',
    border: '1.5px solid var(--muted-foreground)',
    borderRadius: '0.3em',
    cursor: 'pointer',
  },
  // Checked → fill + a checkmark drawn as a centred SVG BACKGROUND (not the `✓`
  // glyph, whose font metrics pushed it to the box's top-left). background-position
  // center is pixel-exact and font-independent.
  '.cm-task-marker-checked::after': {
    background:
      "var(--info) url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ffffff' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12.5l4.5 4.5L19 7'/></svg>\") center / 0.72em no-repeat",
    borderColor: 'var(--info)',
  },

  // Image widget — `width:100%` stretches it to the full editor (prose) width,
  // matching the media card; `height:auto` keeps the aspect ratio.
  '.cm-img': {
    display: 'inline-block',
    width: '100%',
    height: 'auto',
    borderRadius: '8px',
    verticalAlign: 'bottom',
  },
  // Media card (SPIKE: native webview controls). Inline-block (like `.cm-img`) so
  // the inline replace renders in flow AND the caret can land on the line, but
  // `width:100%` stretches the player to the full editor (prose) width.
  '.cm-media-card': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'bottom',
    margin: 'var(--prose-gap-block, 14px) 0',
    // The player is a non-text widget — never let a text drag highlight/grab it
    // (Obsidian keeps the embed clean while you select just the source line).
    userSelect: 'none',
  },
  '.cm-media-card video': {
    width: '100%',
    borderRadius: '8px',
    display: 'block',
  },
  '.cm-media-card audio': {
    width: '100%',
    display: 'block',
  },
  // Table widget — the wrapper is the positioning context for the hover "+" rails.
  // Vertical spacing as PADDING (not margin): CM6 measures a block widget's height
  // from its bounding box, which excludes margins — margin left the heightmap ~28px
  // short per table, so clicks / vertical arrows below the table mapped to the wrong
  // line. Padding is inside the box and the heightmap counts it.
  '.cm-table-wrap': {
    padding: 'var(--prose-gap-block, 14px) 0',
  },
  // Hugs the table (no padding) and is the positioning context for the hover rails,
  // so they anchor to the table edge, not the padded wrap.
  '.cm-table-frame': {
    position: 'relative',
  },
  // Add-column (right edge) / add-row (bottom edge) rails — revealed on hover.
  '.cm-table-addcol, .cm-table-addrow': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--muted-foreground)',
    background: 'color-mix(in oklch, var(--muted) 55%, transparent)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    lineHeight: '1',
    opacity: '0',
    transition: 'opacity 120ms',
  },
  '.cm-table-addcol': { top: '0', bottom: '0', right: '-18px', width: '14px' },
  '.cm-table-addrow': { left: '0', right: '0', bottom: '-18px', height: '14px' },
  '.cm-table-wrap:hover .cm-table-addcol, .cm-table-wrap:hover .cm-table-addrow': {
    opacity: '1',
  },
  // Per-column (top gutter) / per-row (left gutter) delete handles — each revealed
  // only when its own column-header / row is hovered.
  '.cm-table-delcol, .cm-table-delrow': {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '15px',
    height: '15px',
    padding: '0',
    color: 'var(--muted-foreground)',
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    lineHeight: '1',
    opacity: '0',
    transition: 'opacity 120ms',
    zIndex: '1',
  },
  '.cm-table-delcol': { top: '-19px', left: '50%', transform: 'translateX(-50%)' },
  '.cm-table-delrow': { left: '-19px', top: '50%', transform: 'translateY(-50%)' },
  '.cm-md-table th:hover .cm-table-delcol': { opacity: '1' },
  '.cm-md-table tr:hover .cm-table-delrow': { opacity: '1' },
  '.cm-md-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '0.92em',
  },
  '.cm-md-table th, .cm-md-table td': {
    position: 'relative',
    border: '1px solid var(--border)',
    padding: '0.35em 0.6em',
    textAlign: 'left',
    // Keep empty cells (e.g. a just-added row/column) visibly sized instead of
    // collapsing to a sliver. `height` acts as a min-height on table cells.
    minWidth: '3em',
    height: '2.2em',
  },
  '.cm-md-table th': {
    background: 'color-mix(in oklch, var(--muted) 60%, transparent)',
    fontWeight: '600',
  },
  // In-place cells host a NESTED editor — drop the cell's own padding (the nested
  // .cm-content supplies it) and let the editor fill the cell from the top.
  '.cm-celledit th, .cm-celledit td': { padding: '0', verticalAlign: 'top' },
  // In-place editable cell body (#/dev/celledit): fills the cell, no harsh native
  // focus ring — a subtle tint marks the active cell instead.
  '.cm-cell-body': {
    outline: 'none',
    minHeight: '1.2em',
  },
  '.cm-cell-body:focus': {
    background: 'color-mix(in oklch, var(--info) 12%, transparent)',
    borderRadius: '3px',
  },
})
