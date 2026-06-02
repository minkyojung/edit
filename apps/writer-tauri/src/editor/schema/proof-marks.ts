/**
 * Proof Mark Schemas
 *
 * Anchors for suggestions, comments, review marks, and authored marks.
 * Serialized as inline HTML spans with data-proof attributes.
 */

import { $markSchema, $markAttr } from '@milkdown/kit/utils';
import type { Attrs } from '@milkdown/kit/prose/model';
import type { MarkdownNode } from '@milkdown/kit/transformer';

type ProofSuggestionKind = 'insert' | 'delete' | 'replace';

type ProofNode = {
  type?: string;
  proof?: string;
  attrs?: Record<string, string | null | undefined>;
  children?: MarkdownNode[];
};

function normalizeSuggestionKind(kind: string | null | undefined): ProofSuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind;
  return 'replace';
}

function parseCommonAttrs(dom: HTMLElement): { id: string | null; by: string } {
  return {
    id: dom.getAttribute('data-id'),
    by: dom.getAttribute('data-by') || 'unknown',
  };
}

function buildCommonDomAttrs(mark: { attrs: { id?: string | null; by?: string | null } }): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (mark.attrs.id) attrs['data-id'] = mark.attrs.id;
  if (mark.attrs.by) attrs['data-by'] = mark.attrs.by;
  return attrs;
}

// Marks are intentionally NOT serialised into markdown. Their identity
// + metadata ride in the sidecar JSON file written alongside each .md
// (Phase 4 — see lib/docFileSync.ts). On load, markResolver re-anchors
// marks against the body text via quote + context + occurrence.
//
// This keeps the body markdown clean for external tools (vim, qmd,
// git diff, Obsidian) — no `<span data-proof="...">` clutter — and
// matches the on-disk layout decision documented in
// docs/refactor-proof-sdk-removal/07-file-based-pivot.md (결정 3).
const skipMarkSerialize = (): void => {
  /* no-op: mark is silent at the markdown layer */
}

// Suggestion mark
export const proofSuggestionAttr = $markAttr('proofSuggestion', () => ({
  id: {},
  kind: {},
  by: {},
}));

// proofSuggestion attrs are the anchor surface — `id` for lookup,
// `kind` for visual differentiation (insert/delete/replace deco class +
// the markStore accept branching). The rich metadata (quote, content,
// status, createdAt, sourceLabel, etc.) lives on the domain Mark in
// Y.Map('marks'), keyed by `id`. This split was the Phase 1+2 refactor
// — PM is the visibility layer, Y.Map is identity + state.
export const proofSuggestionSchema = $markSchema('proofSuggestion', (ctx) => ({
  attrs: {
    id: { default: null },
    kind: { default: 'replace' },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="suggestion"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        ...parseCommonAttrs(dom),
        kind: normalizeSuggestionKind(dom.getAttribute('data-kind')),
      }),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofSuggestionAttr.key)(mark);
    return [
      'span',
      {
        'data-proof': 'suggestion',
        'data-kind': normalizeSuggestionKind(mark.attrs.kind),
        ...buildCommonDomAttrs(mark),
        ...attrs,
      },
      0,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'suggestion',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        kind: normalizeSuggestionKind(attrs.kind),
        by: attrs.by ?? 'unknown',
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofSuggestion',
    runner: skipMarkSerialize,
  },
}));

// Comment mark
export const proofCommentAttr = $markAttr('proofComment', () => ({
  id: {},
  by: {},
}));

export const proofCommentSchema = $markSchema('proofComment', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="comment"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofCommentAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-proof': 'comment',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'comment',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofComment',
    runner: skipMarkSerialize,
  },
}));

// Flagged mark — RESERVED.
//
// Schema is defined but currently has no mutation path: markStore
// doesn't expose a `flag()` API, MarkKind has no 'flagged' value,
// schemaMap.ts doesn't map to it, and no UI surface creates one.
// Kept as a placeholder for the future fact-check / contradiction-
// detection feature (Karpathy plan Phase 4 — Wiki Lint). When that
// feature lands, wire MarkKind → schemaMap → markStore.add the same
// way 'comment' / 'suggestion' / 'authored' are wired.
//
// Structurally this is twin to proofComment (same attrs, same DOM
// shape, same serialization). The two diverge only on the
// data-proof tag string ("comment" vs "flagged") so a future UI
// can branch on mark type and render different colors / icons /
// priority. CSS deco class `.mark-deco--flagged` is already wired
// in markDecoPlugin.ts for the same reason.
export const proofFlaggedAttr = $markAttr('proofFlagged', () => ({
  id: {},
  by: {},
}));

export const proofFlaggedSchema = $markSchema('proofFlagged', (ctx) => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="flagged"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofFlaggedAttr.key)(mark);
    const domAttrs: Record<string, string> = {
      'data-proof': 'flagged',
      ...buildCommonDomAttrs(mark),
      ...attrs,
    };
    return ['span', domAttrs, 0];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'flagged',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofFlagged',
    runner: skipMarkSerialize,
  },
}));

// Authored mark
export const proofAuthoredAttr = $markAttr('proofAuthored', () => ({
  by: {},
  id: {},
}));

export const proofAuthoredSchema = $markSchema('proofAuthored', (ctx) => ({
  attrs: {
    by: { default: 'human:unknown' },
    id: { default: null },
  },
  inclusive: true,
  excludes: 'proofAuthored',
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="authored"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        by: dom.getAttribute('data-by') || 'human:unknown',
        id: dom.getAttribute('data-proof-id') || dom.getAttribute('data-id') || null,
      }),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofAuthoredAttr.key)(mark);
    return [
      'span',
      {
        'data-proof': 'authored',
        'data-by': mark.attrs.by,
        'data-proof-id': mark.attrs.id ?? null,
        ...attrs,
      },
      0,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'authored',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, {
        by: attrs.by ?? 'human:unknown',
        id: attrs.id ?? null,
      });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofAuthored',
    runner: skipMarkSerialize,
  },
}));

// Highlight mark — a PERSISTENT user highlight on a saved article.
// Unlike the suggestion/comment marks (transient AI review state held in
// pendingChangesStore), a highlight is durable: its source of truth is a
// record in the article's `.meta.json` (id + quote + note + occurrence),
// and this mark is just the re-anchored *render* of that record. So the
// mark carries only `id` — the note text is looked up from the record.
// Silent in markdown like the other proof marks (keeps the .md clean).
export const proofHighlightAttr = $markAttr('proofHighlight', () => ({
  id: {},
}));

export const proofHighlightSchema = $markSchema('proofHighlight', (ctx) => ({
  attrs: {
    id: { default: null },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-highlight]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        id: dom.getAttribute('data-id') || null,
      }),
    },
  ],
  toDOM: (mark) => {
    const attrs = ctx.get(proofHighlightAttr.key)(mark);
    return [
      'span',
      {
        'data-highlight': 'true',
        'data-id': mark.attrs.id ?? null,
        ...attrs,
      },
      0,
    ];
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'highlight',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode;
      const attrs = proofNode.attrs || {};
      state.openMark(markType, { id: attrs.id ?? null });
      state.next(proofNode.children || []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofHighlight',
    runner: skipMarkSerialize,
  },
}));

export const proofMarkPlugins = [
  proofSuggestionAttr,
  proofSuggestionSchema,
  proofCommentAttr,
  proofCommentSchema,
  proofFlaggedAttr,
  proofFlaggedSchema,
  proofAuthoredAttr,
  proofAuthoredSchema,
  proofHighlightAttr,
  proofHighlightSchema,
];
