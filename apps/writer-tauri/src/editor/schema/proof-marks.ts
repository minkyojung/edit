/**
 * Proof Mark Schemas
 *
 * Anchors for suggestions, comments, review marks, and authored marks.
 * Serialized as inline HTML spans with data-proof attributes.
 */

import { $markSchema, $markAttr } from '@milkdown/kit/utils';
import type { Attrs, Mark } from '@milkdown/kit/prose/model';
import type { SerializerState, MarkdownNode } from '@milkdown/kit/transformer';

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

function serializeProofMark(
  state: SerializerState,
  mark: Mark,
  proof: string,
  attrs: Record<string, string | null>
): void {
  state.withMark(mark, 'proofMark', undefined, { proof, attrs });
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
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'suggestion', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
        kind: normalizeSuggestionKind(mark.attrs.kind),
      });
    },
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
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'comment', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
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
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'flagged', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      });
    },
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
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'authored', {
        by: mark.attrs.by ?? null,
        id: mark.attrs.id ?? null,
      });
    },
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
];
