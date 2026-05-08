/**
 * Proof Mark Schemas — adapted from proof-sdk.
 *
 * Inline ProseMirror marks that anchor suggestions/comments/etc. to the
 * exact text range. Yjs syncs these as part of Y.XmlFragment so the server
 * can locate the anchor when applying accept/reject without relying on
 * fragile char-offset coordinates.
 *
 * parseMarkdown/toMarkdown handlers are dormant in this app (we sync via
 * Yjs binary, not markdown), but kept to remain wire-compatible if the
 * remark proof-marks plugin is ever added.
 */

import { $markSchema, $markAttr } from '@milkdown/kit/utils'
import type { Attrs, Mark } from '@milkdown/kit/prose/model'
import type { MarkdownNode, SerializerState } from '@milkdown/transformer'

type ProofSuggestionKind = 'insert' | 'delete' | 'replace'

// Loose shape for incoming markdown AST nodes — proof marks land as
// `proofMark` nodes with arbitrary string attrs; we narrow at use sites.
// `children` is typed as MarkdownNode[] so `state.next()` accepts it.
type ProofNode = MarkdownNode & {
  proof?: string
  attrs?: Record<string, string | null | undefined>
}

function normalizeSuggestionKind(kind: string | null | undefined): ProofSuggestionKind {
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return kind
  return 'replace'
}

function parseCommonAttrs(dom: HTMLElement): { id: string | null; by: string } {
  return {
    id: dom.getAttribute('data-id'),
    by: dom.getAttribute('data-by') || 'unknown',
  }
}

function buildCommonDomAttrs(mark: { attrs: { id?: string | null; by?: string | null } }): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (mark.attrs.id) attrs['data-id'] = mark.attrs.id
  if (mark.attrs.by) attrs['data-by'] = mark.attrs.by
  return attrs
}

function serializeProofMark(
  state: SerializerState,
  mark: Mark,
  proof: string,
  attrs: Record<string, string | null>,
): void {
  state.withMark(mark, 'proofMark', undefined, { proof, attrs })
}

// ── Suggestion ────────────────────────────────────────────────────────────
export const proofSuggestionAttr = $markAttr('proofSuggestion', () => ({
  id: {},
  kind: {},
  by: {},
}))

export const proofSuggestionSchema = $markSchema('proofSuggestion', () => ({
  attrs: {
    id: { default: null },
    kind: { default: 'replace' },
    by: { default: 'unknown' },
    content: { default: null },
    status: { default: null },
    createdAt: { default: null },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="suggestion"]',
      getAttrs: (dom: HTMLElement): Attrs => {
        const common = parseCommonAttrs(dom)
        return {
          ...common,
          kind: normalizeSuggestionKind(dom.getAttribute('data-kind')),
          content: dom.getAttribute('data-content'),
          status: dom.getAttribute('data-status'),
          createdAt: dom.getAttribute('data-created-at'),
        }
      },
    },
  ],
  toDOM: (mark) => {
    const domAttrs: Record<string, string> = {
      'data-proof': 'suggestion',
      'data-kind': normalizeSuggestionKind(mark.attrs.kind),
      ...buildCommonDomAttrs(mark),
    }
    if (mark.attrs.content) domAttrs['data-content'] = String(mark.attrs.content)
    if (mark.attrs.status) domAttrs['data-status'] = String(mark.attrs.status)
    if (mark.attrs.createdAt) domAttrs['data-created-at'] = String(mark.attrs.createdAt)
    return ['span', domAttrs, 0]
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'suggestion',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode
      const attrs = proofNode.attrs || {}
      state.openMark(markType, {
        id: attrs.id ?? null,
        kind: normalizeSuggestionKind(attrs.kind),
        by: attrs.by ?? 'unknown',
        content: attrs.content ?? null,
        status: attrs.status ?? null,
        createdAt: attrs.createdAt ?? null,
      })
      state.next(proofNode.children || [])
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofSuggestion',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'suggestion', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
        kind: normalizeSuggestionKind(mark.attrs.kind),
      })
    },
  },
}))

// ── Comment ───────────────────────────────────────────────────────────────
export const proofCommentAttr = $markAttr('proofComment', () => ({
  id: {},
  by: {},
}))

export const proofCommentSchema = $markSchema('proofComment', () => ({
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
    const domAttrs: Record<string, string> = {
      'data-proof': 'comment',
      ...buildCommonDomAttrs(mark),
    }
    return ['span', domAttrs, 0]
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'comment',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode
      const attrs = proofNode.attrs || {}
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      })
      state.next(proofNode.children || [])
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofComment',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'comment', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      })
    },
  },
}))

// ── Flagged ───────────────────────────────────────────────────────────────
export const proofFlaggedAttr = $markAttr('proofFlagged', () => ({
  id: {},
  by: {},
}))

export const proofFlaggedSchema = $markSchema('proofFlagged', () => ({
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
    const domAttrs: Record<string, string> = {
      'data-proof': 'flagged',
      ...buildCommonDomAttrs(mark),
    }
    return ['span', domAttrs, 0]
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'flagged',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode
      const attrs = proofNode.attrs || {}
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      })
      state.next(proofNode.children || [])
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofFlagged',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'flagged', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      })
    },
  },
}))

// ── Approved ──────────────────────────────────────────────────────────────
export const proofApprovedAttr = $markAttr('proofApproved', () => ({
  id: {},
  by: {},
}))

export const proofApprovedSchema = $markSchema('proofApproved', () => ({
  attrs: {
    id: { default: null },
    by: { default: 'unknown' },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="approved"]',
      getAttrs: (dom: HTMLElement): Attrs => parseCommonAttrs(dom),
    },
  ],
  toDOM: (mark) => {
    const domAttrs: Record<string, string> = {
      'data-proof': 'approved',
      ...buildCommonDomAttrs(mark),
    }
    return ['span', domAttrs, 0]
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'approved',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode
      const attrs = proofNode.attrs || {}
      state.openMark(markType, {
        id: attrs.id ?? null,
        by: attrs.by ?? 'unknown',
      })
      state.next(proofNode.children || [])
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofApproved',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'approved', {
        id: mark.attrs.id ?? null,
        by: mark.attrs.by ?? null,
      })
    },
  },
}))

// ── Authored ──────────────────────────────────────────────────────────────
export const proofAuthoredAttr = $markAttr('proofAuthored', () => ({
  by: {},
  id: {},
}))

export const proofAuthoredSchema = $markSchema('proofAuthored', () => ({
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
  toDOM: (mark) => [
    'span',
    {
      'data-proof': 'authored',
      'data-by': mark.attrs.by,
      'data-proof-id': mark.attrs.id ?? null,
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'authored',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode
      const attrs = proofNode.attrs || {}
      state.openMark(markType, {
        by: attrs.by ?? 'human:unknown',
        id: attrs.id ?? null,
      })
      state.next(proofNode.children || [])
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofAuthored',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'authored', {
        by: mark.attrs.by ?? null,
        id: mark.attrs.id ?? null,
      })
    },
  },
}))

// ── Provenance ───────────────────────────────────────────────────────────
// Permanent breadcrumb left on LLM-origin text after the user accepts it.
// Visually invisible (no styling in toDOM beyond a data attr) so the page
// reads as plain prose; hover plugin uses the data attrs to surface a
// "where did this come from?" popover. Carries the source metadata that
// was on the proofSuggestion at accept time, plus an acceptedAt stamp.
export const proofProvenanceAttr = $markAttr('proofProvenance', () => ({
  id: {},
}))

export const proofProvenanceSchema = $markSchema('proofProvenance', () => ({
  attrs: {
    id: { default: null },
    sourceSlug: { default: null },
    sourceLabel: { default: null },
    sourceQuote: { default: null },
    proposedAt: { default: null },
    acceptedAt: { default: null },
    model: { default: null },
  },
  inclusive: false,
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="provenance"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        id: dom.getAttribute('data-id'),
        sourceSlug: dom.getAttribute('data-source-slug'),
        sourceLabel: dom.getAttribute('data-source-label'),
        sourceQuote: dom.getAttribute('data-source-quote'),
        proposedAt: dom.getAttribute('data-proposed-at'),
        acceptedAt: dom.getAttribute('data-accepted-at'),
        model: dom.getAttribute('data-model'),
      }),
    },
  ],
  toDOM: (mark) => {
    const domAttrs: Record<string, string> = { 'data-proof': 'provenance' }
    if (mark.attrs.id) domAttrs['data-id'] = String(mark.attrs.id)
    if (mark.attrs.sourceSlug) domAttrs['data-source-slug'] = String(mark.attrs.sourceSlug)
    if (mark.attrs.sourceLabel) domAttrs['data-source-label'] = String(mark.attrs.sourceLabel)
    if (mark.attrs.sourceQuote) domAttrs['data-source-quote'] = String(mark.attrs.sourceQuote)
    if (mark.attrs.proposedAt) domAttrs['data-proposed-at'] = String(mark.attrs.proposedAt)
    if (mark.attrs.acceptedAt) domAttrs['data-accepted-at'] = String(mark.attrs.acceptedAt)
    if (mark.attrs.model) domAttrs['data-model'] = String(mark.attrs.model)
    return ['span', domAttrs, 0]
  },
  parseMarkdown: {
    match: (node) => (node as ProofNode).type === 'proofMark' && (node as ProofNode).proof === 'provenance',
    runner: (state, node, markType) => {
      const proofNode = node as ProofNode
      const attrs = proofNode.attrs || {}
      state.openMark(markType, {
        id: attrs.id ?? null,
        sourceSlug: attrs.sourceSlug ?? null,
        sourceLabel: attrs.sourceLabel ?? null,
        sourceQuote: attrs.sourceQuote ?? null,
        proposedAt: attrs.proposedAt ?? null,
        acceptedAt: attrs.acceptedAt ?? null,
        model: attrs.model ?? null,
      })
      state.next(proofNode.children || [])
      state.closeMark(markType)
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofProvenance',
    runner: (state, mark) => {
      serializeProofMark(state, mark, 'provenance', {
        id: mark.attrs.id ?? null,
        sourceSlug: mark.attrs.sourceSlug ?? null,
        sourceLabel: mark.attrs.sourceLabel ?? null,
        sourceQuote: mark.attrs.sourceQuote ?? null,
        proposedAt: mark.attrs.proposedAt ?? null,
        acceptedAt: mark.attrs.acceptedAt ?? null,
        model: mark.attrs.model ?? null,
      })
    },
  },
}))

// $markSchema returns a tuple `[$Ctx, $Mark]` (both MilkdownPlugin) plus
// extra accessor props. Spreading the tuples here flattens the array to a
// plain MilkdownPlugin[] so it satisfies Editor.use() without casts.
export const proofMarkPlugins = [
  proofSuggestionAttr,
  ...proofSuggestionSchema,
  proofCommentAttr,
  ...proofCommentSchema,
  proofFlaggedAttr,
  ...proofFlaggedSchema,
  proofApprovedAttr,
  ...proofApprovedSchema,
  proofAuthoredAttr,
  ...proofAuthoredSchema,
  proofProvenanceAttr,
  ...proofProvenanceSchema,
]
